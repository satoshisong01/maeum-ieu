/** DB 메시지 저장 */

import { prisma } from "@/lib/prisma";
import { after } from "next/server";
import { saveMessageEmbedding } from "@/lib/rag";
import { getNowKst, toKstDateString } from "./time";
import type { CognitiveCheck } from "./types";

/** 인지 평가 결과를 cognitive_assessments 테이블에 저장 */
export async function saveCognitiveAssessments(
  userId: string,
  messageId: string,
  conversationId: string,
  checks: CognitiveCheck[],
): Promise<void> {
  if (checks.length === 0) return;
  const sessionDate = toKstDateString(new Date());
  // 항목별 독립 INSERT — 순차 N+1 대신 병렬 실행(라운드트립 누적 방지)
  await Promise.all(checks.map((check, i) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO cognitive_assessments (id, user_id, message_id, conversation_id, domain, score, confidence, evidence, note, session_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, NOW())
       ON CONFLICT (id) DO UPDATE SET score = EXCLUDED.score, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, note = EXCLUDED.note`,
      // 결정적 id(메시지+도메인+인덱스) — 같은 메시지 재분석 시 최신 점수로 덮어씀(이전 DO NOTHING은 정정 점수를 버려 등급 과소평가)
      `ca_${messageId}_${check.domain}_${i}`,
      userId, messageId, conversationId,
      check.domain, check.score, check.confidence, check.evidence, check.note, sessionDate,
    ),
  ));
}

/** 사용자 + AI 메시지 저장 */
export async function saveMessages(params: {
  conversationId: string;
  userId: string;
  userContent: string;
  assistantContent: string;
  emergencyLevel?: number;
  emergencyEvidence?: string;
  speakerLabel?: string | null;
  /** 폴백 멘트 등 정형 응답은 RAG 임베딩에서 제외(검색 오염 방지) */
  skipAssistantEmbedding?: boolean;
  /** 정신건강 검진 정형 답변("그런 편이에요" 등)은 사용자 발화도 임베딩 제외 — 인지 RAG 오염 방지 */
  skipUserEmbedding?: boolean;
}): Promise<{ userMsgId: string; assistantMsgId: string }> {
  const { conversationId, userId, userContent, assistantContent, emergencyLevel, emergencyEvidence, speakerLabel, skipAssistantEmbedding, skipUserEmbedding } = params;
  const userTime = getNowKst();
  // assistant 메시지는 1초 뒤로 설정 → createdAt ASC 정렬 시 항상 user → assistant 순서 보장
  const assistantTime = new Date(userTime.getTime() + 1000);

  // Phase 1 휴리스틱: 응급/이상 신호가 있으면 보호자 검토용으로 null 유지,
  // 그 외 일반 발화는 wake-word 사용 환경 가정 하에 "primary" 라벨.
  const inferredLabel = speakerLabel !== undefined
    ? speakerLabel
    : (emergencyLevel && emergencyLevel >= 2) ? null : "primary";

  const userMsg = await prisma.message.create({
    data: {
      conversationId, role: "user", content: userContent, createdAt: userTime,
      emergencyLevel: emergencyLevel ?? null,
      emergencyEvidence: emergencyEvidence ?? null,
      speakerLabel: inferredLabel,
    },
  });
  /**
   * ⚠ 트랜잭션이 아니다. user 행은 들어갔는데 아래 둘이 실패하면, 예외가 전파되면서
   *   **이미 만들어진 userMsgId가 버려진다**. 응급 경로에서 그 결과가 고약하다:
   *   DB에는 `emergencyLevel=3, notifiedAt=null` 행이 남고 호출부는 id가 없어 마킹을 못 한다
   *   → scripts/pilot-daily-check.ts가 "🔴 알림 대상이 있는데 미발송"으로 **거짓 경보**를 내고,
   *     dedup 앵커가 없어 같은 응급이 다음 턴에 다시 발송된다.
   *   user 행이 생긴 이상 그 id는 돌려주는 게 맞다(assistant 행 유실은 대화 품질 문제일 뿐).
   */
  let assistantMsg: { id: string; content: string } | null = null;
  try {
    assistantMsg = await prisma.message.create({
      data: { conversationId, role: "assistant", content: assistantContent, createdAt: assistantTime },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: assistantTime },
    });
  } catch (e) {
    console.error("[saveMessages] assistant/conversation 쓰기 실패 — user 행은 생성됨:", e instanceof Error ? e.message : e);
  }

  // RAG 임베딩 (응답 흐름은 막지 않되, 실패는 로깅 — 조용한 삼킴은 message↔vector 불일치를 은폐)
  //   ⚠ after()로 실행 보장 — 부유 프라미스로 두면 서버리스가 응답 직후 인스턴스를 freeze할 때
  //     유실되고, 그 유실은 로그에도 남지 않는다. Message는 있는데 embedding만 없는 상태가
  //     누적되면 RAG 회상에 조용한 공백이 생긴다(이 프로젝트가 반복 수정해 온 증상).
  const embedTasks = async () => {
    if (!skipUserEmbedding) {
      await saveMessageEmbedding(userId, userMsg.id, userMsg.content).catch((e) => console.warn("[rag] user embed 실패:", (e as Error).message));
    }
    if (!skipAssistantEmbedding && assistantMsg) {
      await saveMessageEmbedding(userId, assistantMsg.id, assistantMsg.content).catch((e) => console.warn("[rag] assistant embed 실패:", (e as Error).message));
    }
  };
  if (!skipUserEmbedding || !skipAssistantEmbedding) {
    try { after(embedTasks); } catch { embedTasks().catch(() => { /* 로깅은 내부에서 */ }); }
  }

  // assistantMsgId는 쓰기 실패 시 빈 문자열 — 호출부는 userMsgId만 쓰므로 안전하고,
  //   빈 값이 들어가면 "assistant 행이 없다"가 드러난다(묵살보다 낫다).
  return { userMsgId: userMsg.id, assistantMsgId: assistantMsg?.id ?? "" };
}

/** 이상징후 발견 시 Message에 마킹 */
export async function markAnomaly(messageId: string, analysisNote: string): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: { isAnomaly: true, analysisNote },
  });
}

/** 최근 24시간 내 같은 대화의 L1 응급 신호 카운트 — L1→L2 승격 판단용 */
export async function countRecentL1Signals(conversationId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.message.count({
    where: {
      conversationId,
      role: "user",
      emergencyLevel: 1,
      createdAt: { gte: since },
    },
  });
}

/** AI 인사 메시지만 저장 */
export async function saveGreetingMessage(conversationId: string, text: string): Promise<void> {
  const nowKst = getNowKst();
  await prisma.message.create({
    data: { conversationId, role: "assistant", content: text, createdAt: nowKst },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: nowKst },
  });
}
