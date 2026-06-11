/** DB 메시지 저장 */

import { prisma } from "@/lib/prisma";
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
       ON CONFLICT (id) DO NOTHING`,
      // 결정적 id(메시지+도메인+인덱스) — 같은 메시지 재분석 시 중복 INSERT 차단(count 왜곡·등급 오류 방지)
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
}): Promise<{ userMsgId: string; assistantMsgId: string }> {
  const { conversationId, userId, userContent, assistantContent, emergencyLevel, emergencyEvidence, speakerLabel, skipAssistantEmbedding } = params;
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
  const assistantMsg = await prisma.message.create({
    data: { conversationId, role: "assistant", content: assistantContent, createdAt: assistantTime },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: assistantTime },
  });

  // RAG 임베딩 (실패해도 무관)
  saveMessageEmbedding(userId, userMsg.id, userMsg.content).catch(() => {});
  if (!skipAssistantEmbedding) {
    saveMessageEmbedding(userId, assistantMsg.id, assistantMsg.content).catch(() => {});
  }

  return { userMsgId: userMsg.id, assistantMsgId: assistantMsg.id };
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
