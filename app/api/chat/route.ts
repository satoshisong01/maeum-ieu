import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Part } from "@google/genai";
import { authOptions } from "@/lib/auth";
import { searchMemories } from "@/lib/rag";
import { extractAndSaveProfile } from "@/lib/chat/profile-extractor";
import { factCheckResponse } from "@/lib/chat/fact-checker";
import type { FullProfile } from "@/lib/chat/profile";
import { maybeTriggerSummaryRollup } from "@/lib/chat/summary-trigger";
import { normalizeImnida } from "@/lib/chat/korean-particle";
import { postProcessReply } from "@/lib/chat/postprocess";
import { classifyIntent, buildIntentHint } from "@/lib/chat/intent-classifier";
import type { ChatRequestBody } from "@/lib/chat/types";
import { ChatRequestSchema } from "@/lib/chat/validation";
import { getTimeContext, getCurrentKstDateTimeString, isDateTimeQuestion, getRelativeTimeLabel } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { getPrefixCache } from "@/lib/chat/prompt-cache";
import { getGenAI, getTextModel, buildFallbackMessage, generateWithFallback, extractText, COMPANION_SAFETY_SETTINGS, logUsage } from "@/lib/chat/llm";
import { buildHistoryText, extractLastAiMessage } from "@/lib/chat/history-text";
import { buildWordGameHint, buildNameAnswerHint, buildRepetitionHint, buildAnomalyCorrectionHint, buildFamilyQueryGuard, buildRecallVerificationHint, buildInfoRequestHint } from "@/lib/chat/hints";
import { detectLowEngagement, buildEngagementHint } from "@/lib/chat/engagement";
import { saveMessages, saveGreetingMessage, saveCognitiveAssessments, markAnomaly, countRecentL1Signals } from "@/lib/chat/messages";
import { runCognitiveAnalysis } from "@/lib/chat/cognitive-run";
import { randomUUID } from "crypto";
import { buildExamPlan, renderDomainBattery, scoreDomainAnswer, isNonResponse, renderDomainReask, itemsForDomain } from "@/lib/screening/exam-runner";
import { classifyProvisional, assessCoverage } from "@/lib/screening/exam-eval";
import { detectInappropriate, buildModerationReply } from "@/lib/chat/moderation";
import { detectEmergency, buildEmergencyL3Reply, buildEmergencyL2Hint, shouldEscalateL1ToL2, type EmergencyResult } from "@/lib/chat/emergency";
import { detectEmergencyLLM } from "@/lib/chat/emergency-llm";
import { evaluateSttConfidence, buildClarificationReply } from "@/lib/chat/stt-confidence";
import { correctTranscriptionByContext } from "@/lib/chat/stt-context-correction";
import { notifyGuardian } from "@/lib/chat/emergency-notify";
import { maybeNotifyCognitiveDecline } from "@/lib/health/cognitive-alert";
import { handleMentalFlow } from "@/lib/health/mental-flow";
import { getMentalFollowupHint } from "@/lib/health/mental-followup";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

// 모델·응답추출 유틸은 lib/chat/llm.ts로 분리(getApiKey/getTextModel/buildFallbackMessage/generateWithFallback/extractText/stripReasoningTrace).

// 프롬프트 hint 빌더는 lib/chat/hints.ts로 분리(buildWordGameHint/buildNameAnswerHint/buildRepetitionHint/buildAnomalyCorrectionHint/buildFamilyQueryGuard/buildRecallVerificationHint/buildInfoRequestHint).
// 응답 후처리(removeParrot/removeTimeLabels/normalizeHonorific/fixChildGenderHonorific/normalizeFamilyChildHonorific/removeUngroundedClaims/fixWordChainStart/removeRepeatedOpening/trimIncomplete/postProcessReply)는 lib/chat/postprocess.ts로 분리(2026-06-10).

// ─── 공통 유틸 ──────────────────────────────────────────────────────────────

type GeminiTurn = { role: "user" | "model"; parts: { text: string }[] };

/**
 * 대화 이력을 Gemini multi-turn `contents` 배열로 변환.
 *
 * 텍스트로 history를 통째 stuff하는 방식 → 모델이 턴 순서/Q-A 페어를 자주 놓침.
 * Gemini가 내부적으로 사용자/모델 턴을 구분하도록 구조화된 contents로 전달한다.
 *
 * 규칙:
 * - Gemini contents는 user/model이 번갈아 와야 하므로 연속된 같은 role은 합친다
 * - 첫 turn은 반드시 user → model로 시작하면 dummy user를 앞에 추가
 * - `currentUserMessage`가 messages 끝 user 메시지와 동일하면 prior에서 제외
 * - 최종 turn은 항상 user (현재 발화) — 가이드 블록(memories/hints)을 함께 주입
 * - 직전 AI 발화가 있으면 final user 텍스트 앞에 "[직전 AI 질문에 대한 답입니다]" 마커 추가
 */
function buildChatContents(params: {
  messages: { role: string; content: string; createdAt?: string }[];
  currentUserMessage: string;
  memories: string;
  hintBlock: string;
  now?: Date;
  maxRecent?: number;
}): GeminiTurn[] {
  // maxRecent 20→24: DB 이력 도입과 함께 컨텍스트 창 소폭 확대 (세션 내 재질문 감소, 토큰 +α 수용)
  const { messages, currentUserMessage, memories, hintBlock, now = new Date(), maxRecent = 24 } = params;

  // 컨텍스트 창(24) 밖 25~80번째 메시지는 사용자 발화만 압축해 다이제스트로 주입 —
  //   "30~60메시지 전 이야기를 기억 못 하는" 세션 중기 기억 공백 해소 (RAG는 랭킹 운에 좌우되어 불충분, 2026-06-11).
  //   사용자 발화만(상대 발화가 기억의 앵커) + 60자 클립 + 최대 40줄 ≈ 1k 토큰 이내.
  const older = messages.slice(0, -maxRecent);
  const olderDigest = older
    .filter((m) => m.role === "user")
    .slice(-40)
    .map((m) => {
      const label = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
      const body = m.content.replace(/\s+/g, " ").trim().slice(0, 60);
      return `· ${label}${body}`;
    })
    .join("\n");

  const recent = messages.slice(-maxRecent);
  // 마지막이 user이고 currentUserMessage와 동일하면 prior에서 제외 (텍스트 모드)
  let prior = recent;
  const lastMsg = recent[recent.length - 1];
  if (lastMsg && lastMsg.role === "user" && lastMsg.content.trim() === (currentUserMessage || "").trim()) {
    prior = recent.slice(0, -1);
  }

  const turns: GeminiTurn[] = [];
  for (const m of prior) {
    const role: "user" | "model" = m.role === "user" ? "user" : "model";
    const timeLabel = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
    const cleaned = m.content.replace(/\s*<!--\s*__mod:[^>]*-->\s*$/g, "").trim();
    if (!cleaned) continue;
    const text = `${timeLabel}${cleaned}`;
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.role === role) {
      lastTurn.parts[0].text += `\n${text}`;
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  }

  // Gemini는 첫 contents가 user여야 함 — model로 시작하면 dummy user 끼워넣기
  if (turns.length > 0 && turns[0].role === "model") {
    turns.unshift({ role: "user", parts: [{ text: "(대화 시작)" }] });
  }

  // 직전 AI 발화 확인 → 명시적 Q-A 페어링 마커
  const lastPrior = prior[prior.length - 1];
  const lastWasAi = lastPrior && lastPrior.role !== "user";
  const qaMarker = lastWasAi
    ? `[지금 사용자의 답변은 바로 위 AI의 마지막 발화에 대한 응답입니다. 새 주제가 아니라 그 흐름을 이어받으세요.]\n`
    : "";

  const cleanedHints = (hintBlock || "").trim();
  const finalText = [
    olderDigest ? `[이번 세션 앞부분 — 사용자 발화 요약 (위 대화 직전 흐름, 질문받으면 참고)]\n${olderDigest}` : "",
    memories ? `[참고 — 과거 메모리]\n${memories}` : "",
    cleanedHints,
    `${qaMarker}[현재 사용자 발화]\n${currentUserMessage || "(빈 메시지)"}`,
  ].filter(Boolean).join("\n\n");

  // 마지막 prior turn이 user면 합치고, 아니면 새 user turn 추가
  const tail = turns[turns.length - 1];
  if (tail && tail.role === "user") {
    tail.parts[0].text += `\n\n${finalText}`;
  } else {
    turns.push({ role: "user", parts: [{ text: finalText }] });
  }
  return turns;
}

/**
 * RAG 메모리 조회 — searchMemories에 DISTINCT ON dedup + limit 15.
 *
 * 진단 결과(2026-05-26): "마당 청소 좀 했어" 같은 발화가 4번 중복 임베딩되어 top 차지,
 *   다양성 있는 다른 메시지(제라늄/백일홍)가 밀려남. dedup으로 해결.
 * enriched query(recent 3 join)는 가족/명절 토픽이 너무 강해져 마당/화분이 희석되는 부작용 있어 미사용.
 */
async function fetchMemories(userId: string, query: string): Promise<string> {
  try { return await searchMemories(userId, query, 15); }
  catch { return ""; }
}

/**
 * 대화 이력을 DB에서 직접 로드 (최근 80개) — 클라이언트 slice(50)·컨텍스트 윈도우(20) 너머의
 * 세션 내 기억 공백("아까 외운 단어를 외운 적 없다", 화투 재질문) 해소.
 * DB가 ground truth이므로 클라이언트 페이로드 의존도 제거. 실패 시 빈 배열(호출부가 클라이언트 이력으로 폴백).
 */
async function fetchRecentHistory(conversationId: string): Promise<{ role: string; content: string; createdAt?: string }[]> {
  try {
    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: { role: true, content: true, createdAt: true },
    });
    return rows.reverse().map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() }));
  } catch (e) {
    console.warn("[history] DB fetch failed — falling back to client messages:", (e as Error).message);
    return [];
  }
}

function toSafeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  const isQuota = /429|Too Many|quota|Quota exceeded|rate|GoogleGenerativeAI/.test(raw);
  return isQuota ? "오늘은 사용할 수 없습니다. 잠시 후 다시 시도해 주세요." : "답변 생성 중 오류가 발생했습니다.";
}

// 인지 분석 실행부는 lib/chat/cognitive-run.ts로 추출 (Live 음성 경로 /api/live/turn과 공유, 2026-06-12)

// ─── 핸들러 ─────────────────────────────────────────────────────────────────

/** 1) 최초 인사 */
async function handleFirstGreeting(systemPrompt: string, userName: string, honorific: string, companionName: string, companionRelation: string, conversationId?: string) {
  const model = getTextModel(systemPrompt, false); // 인사엔 googleSearch 불필요(지연·비용 절감)
  const { text: raw } = await generateWithFallback(
    model,
    `지금 ${userName}님이 대화를 시작합니다. ${companionRelation} '${companionName}'으로서 ${honorific}을 부르며 시간대에 맞는 인사 한 마디만 짧게 해주세요. (본인 소개 포함)`,
    `${honorific}, 안녕하세요! ${companionName}예요. 오늘 하루 어떻게 보내고 계세요?`,
  );
  const text = normalizeImnida(raw);  // "수지이에요" → "수지예요"
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 2) 재접속 인사 — AI가 먼저 인지 질문을 자연스럽게 포함 */
async function handleReturningGreeting(systemPrompt: string, userName: string, honorific: string, conversationId?: string, userId?: string, mode?: string) {
  const model = getTextModel(systemPrompt, false); // 인사엔 googleSearch 불필요(지연·비용 절감)
  // T3 후속: 위기 체크인(7일 내) / 2주 경과 재검 권유 — 일반인(general) 전용, 실패는 null 무해화
  const mentalHint = userId && mode === "general" ? await getMentalFollowupHint(userId) : null;
  const { text } = await generateWithFallback(
    model,
    `${userName}(${honorific})님이 다시 돌아왔습니다. 자기소개 반복하지 말고, "다시 오셨네요" 스타일로 따뜻하게 반겨주세요.${mentalHint ?? ""}

[중요 — 시간대에 맞는 인사·식사 질문]
위 [현재 환경 정보]의 "시간대" 라벨(새벽/아침/오전/점심/오후/저녁/밤)을 **반드시 확인**해서 시간대에 맞는 식사 질문을 하세요:
- 새벽/아침 (~10시): "아침은 드셨어요?" / "잘 주무셨어요?"
- 오전 (10~11시): "오전은 어떻게 보내고 계세요?"
- 점심 (11~14시): "점심 맛있게 드셨어요?"
- 오후 (14~17시): "점심 뭐 드셨어요?" 또는 "오후엔 뭐 하고 계세요?"
- 저녁 (17~20시): "저녁 준비하셨어요?" 또는 "오늘 하루 어떠셨어요?"
- 밤 (20시 이후): "오늘 하루 잘 보내셨어요?"
**시간대와 다른 식사 질문(아침인데 "점심 드셨어요?")은 절대 금지**.

또는 아래 중 하나로 대체 가능:
- 오늘의 기분/컨디션 질문${mode !== "general" ? "\n- 인지 선별 프로토콜에서 아직 확인 안 한 영역의 질문 하나 (시험이 아닌 자연스러운 대화 형식으로)" : ""}

2~3문장 이내. 절대 자기소개 반복하지 마세요.`,
    `${honorific}, 다시 오셨네요! 오늘 하루 어떻게 보내고 계세요?`,
  );
  const cleaned = normalizeImnida(text);
  if (conversationId) await saveGreetingMessage(conversationId, cleaned);
  return NextResponse.json({ text: cleaned, role: "assistant" });
}

/** 2.5) 능동 재참여 — 세션 중 사용자가 한동안 침묵하면 동반자가 먼저 부드럽게 한 문장. attempt 2는 후퇴(압박 0). */
async function handleReEngageGreeting(
  systemPrompt: string, honorific: string, companionName: string,
  history: { role: string; content: string }[], conversationId?: string, attempt = 1,
) {
  const model = getTextModel(systemPrompt, false);
  const lastAi = [...history].reverse().find((m) => m.role === "assistant")?.content?.slice(0, 60) || "";
  // 폴백은 companionName+조사 회피(자음받침 이름의 조사 오류 방지) — 호칭만 사용
  const fallback = attempt >= 2
    ? `${honorific}, 천천히 하셔도 괜찮아요. 여기 같이 있을게요.`
    : `${honorific}, 괜찮으세요? 천천히 말씀하셔도 돼요.`;
  const prompt = attempt >= 2
    ? `${honorific}이 한동안 말씀이 없으세요. 부담 드리지 말고, "천천히 하셔도 괜찮아요, 같이 있을게요"는 느낌으로 **아주 짧게 1~2문장**만. 질문하지 마세요.`
    : `${honorific}이 한동안 말씀이 없으세요. ${lastAi ? `직전에 '${lastAi}' 이야기를 나눴어요. 그 주제를 가볍게 한 번 더 권하거나, ` : ""}편하게 다시 말 걸어 대화를 잇는 **아주 짧게 1~2문장**만(길게 늘어놓지 말 것). 절대 재촉·압박하지 말고, 답을 강요하지 마세요.`;
  const { text } = await generateWithFallback(model, prompt, fallback);
  // 재참여는 '짧은 nudge'가 핵심(과다발화 방지) — LLM이 길게 뱉어도 첫 2문장으로 하드 캡
  const cleaned = normalizeImnida(text).split(/(?<=[.!?~])\s+/).slice(0, 2).join(" ").trim();
  if (conversationId) await saveGreetingMessage(conversationId, cleaned);
  return NextResponse.json({ text: cleaned, role: "assistant" });
}

// ─── 전문가 검진 상태머신 (Phase 2) ───────────────────────────────────────
interface ExamSessionRow { id: string; item_order: string | null; current_item: number; reask_count: number; answered_domains: number }

const MAX_REASK = 2; // 무응답 영역당 재질문 최대 횟수(이후 무응답 처리·다음 영역)

/** 진행 중(미종료) 검진 세션 조회 — 전문가(actor)↔환자 기준. */
async function lookupOpenExam(expertId: string, patientId: string): Promise<ExamSessionRow | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<ExamSessionRow[]>(
      `SELECT id, item_order, current_item, COALESCE(reask_count,0) AS reask_count, COALESCE(answered_domains,0) AS answered_domains FROM exam_session WHERE expert_user_id = $1 AND patient_user_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      expertId, patientId);
    return rows[0] ?? null;
  } catch { return null; }
}

/** 채점용 환경(오늘 날짜·요일·계절) — 시간 지남력 정답 판정에 필요. */
function examEnv(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
  const mo = kst.getUTCMonth() + 1;
  const season = mo === 12 || mo <= 2 ? "겨울" : mo <= 5 ? "봄" : mo <= 8 ? "여름" : "가을";
  return `오늘은 ${kst.getUTCFullYear()}년 ${mo}월 ${kst.getUTCDate()}일 ${wd}요일, 계절은 ${season}.`;
}

/** 검진 시작 — 영역 순서 확정 + 첫 영역 문항 제시(자동 인사 대체). */
async function handleExamGreeting(examSession: ExamSessionRow, conversationId: string | undefined, dateSeed: string) {
  // 멱등: 이미 시작된(item_order 있는) 세션이면 리셋·재채점하지 말고 현재 영역만 재안내(재접속/재인사 중복 방지)
  if (examSession.item_order) {
    const cur: string[] = (() => { try { return JSON.parse(examSession.item_order || "[]"); } catch { return []; } })();
    const at = Math.min(Math.max(0, examSession.current_item ?? 0), Math.max(0, cur.length - 1));
    const text = cur.length ? `검사를 이어서 진행하겠습니다. ${renderDomainBattery(cur[at])}` : "잠시만요, 검사를 준비하고 있어요.";
    if (conversationId) await saveGreetingMessage(conversationId, text);
    return NextResponse.json({ text, role: "assistant" });
  }
  const order = buildExamPlan(`${conversationId ?? "x"}:${dateSeed}`);
  await prisma.$executeRawUnsafe(`UPDATE exam_session SET item_order = $2, current_item = 0, reask_count = 0, answered_domains = 0, total_domains = $3 WHERE id = $1`, examSession.id, JSON.stringify(order), order.length);
  const text = `안녕하세요. 지금부터 기억력과 사고력을 알아보는 간단한 검사를 시작하겠습니다. 편하게 답해 주시면 돼요. ${renderDomainBattery(order[0])}`;
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 검진 한 턴 — 현재 영역 답변을 항목별 채점 → 다음 영역 문항(또는 종료). */
async function handleExamTurn(params: { examSession: ExamSessionRow; answer: string; conversationId?: string; userId: string; transcription?: string }) {
  const { examSession, answer, conversationId, userId, transcription } = params;
  const order: string[] = (() => { try { return JSON.parse(examSession.item_order || "[]"); } catch { return []; } })();
  const idx = examSession.current_item;
  const ans = (answer || "").trim();

  if (!order.length || idx >= order.length) {
    // 비정상 상태(ended_at만 NULL) 자가 복구 — 반복 메시지 루프 방지
    await prisma.$executeRawUnsafe(`UPDATE exam_session SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`, examSession.id).catch(() => {});
    const text = "오늘 검사는 모두 끝났습니다. 수고 많으셨어요.";
    if (conversationId) await saveMessages({ conversationId, userId, userContent: ans || "(응답)", assistantContent: text, skipUserEmbedding: true, skipAssistantEmbedding: true });
    return NextResponse.json({ text, role: "assistant", transcription });
  }

  const domain = order[idx];
  const reask = examSession.reask_count ?? 0;

  // 무응답(빈 응답·거부)이고 재질문 여유가 있으면 — 더 쉬운 표현으로 같은 영역 재질문(채점·진행 보류)
  if (isNonResponse(ans) && reask < MAX_REASK) {
    await prisma.$executeRawUnsafe(`UPDATE exam_session SET reask_count = $2 WHERE id = $1`, examSession.id, reask + 1);
    const lead = reask === 0 ? "괜찮아요, 조금 더 쉽게 여쭤볼게요. " : "한 번만 더 여쭤볼게요. ";
    const text = lead + renderDomainReask(domain);
    if (conversationId) await saveMessages({ conversationId, userId, userContent: ans || "(무응답)", assistantContent: text, skipUserEmbedding: true, skipAssistantEmbedding: true });
    return NextResponse.json({ text, role: "assistant", transcription });
  }

  // 영역 마감 — 무응답이면 0점/무응답으로 기록(채점 호출 안 함), 응답이면 항목별 채점
  const domainAnswered = !isNonResponse(ans);
  if (domainAnswered) {
    const scores = await scoreDomainAnswer(domain, ans, examEnv());
    for (const s of scores) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO exam_item_score (id, session_id, item_id, domain, prompt, answer, score, max_points, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_id, item_id) DO UPDATE SET prompt=EXCLUDED.prompt, answer=EXCLUDED.answer, score=EXCLUDED.score, max_points=EXCLUDED.max_points, reason=EXCLUDED.reason`,
        `eis_${randomUUID()}`, examSession.id, s.itemId, s.domain, s.prompt, s.answer, s.score, s.max, s.reason).catch(() => {});
    }
  } else {
    for (const it of itemsForDomain(domain)) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO exam_item_score (id, session_id, item_id, domain, prompt, answer, score, max_points, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_id, item_id) DO UPDATE SET prompt=EXCLUDED.prompt, answer=EXCLUDED.answer, score=EXCLUDED.score, max_points=EXCLUDED.max_points, reason=EXCLUDED.reason`,
        `eis_${randomUUID()}`, examSession.id, it.id, domain, it.prompt, ans || "", 0, it.points, "무응답").catch(() => {});
    }
  }

  const answered = (examSession.answered_domains ?? 0) + (domainAnswered ? 1 : 0);
  const nextIdx = idx + 1;
  let text: string;
  if (nextIdx >= order.length) {
    const rows = await prisma.$queryRawUnsafe<{ t: number; m: number }[]>(
      `SELECT COALESCE(SUM(score),0)::int t, COALESCE(SUM(max_points),0)::int m FROM exam_item_score WHERE session_id = $1`, examSession.id);
    const total = rows[0]?.t ?? 0, max = rows[0]?.m ?? 0;
    const coverage = assessCoverage(answered, order.length);
    const evalRes = classifyProvisional(total, max, coverage.sufficient);
    await prisma.$executeRawUnsafe(
      `UPDATE exam_session SET current_item = $2, total_score = $3, max_score = $4, answered_domains = $5, reask_count = 0, eval_band = $6, coverage_status = $7, ended_at = now() WHERE id = $1`,
      examSession.id, nextIdx, total, max, answered, evalRes.band, coverage.sufficient ? "ok" : "insufficient");
    // 점수·등급은 환자에게 비노출(검사자만 열람). 자료부족이면 추가 문진 권유만.
    text = coverage.sufficient
      ? "이제 검사가 모두 끝났습니다. 끝까지 잘 해주셔서 감사합니다. 수고 많으셨어요."
      : "오늘은 여기까지 하겠습니다. 답하기 어려우셨던 부분이 있어, 다음에 한 번 더 도와드리며 진행하면 좋겠어요. 수고 많으셨습니다.";
  } else {
    await prisma.$executeRawUnsafe(`UPDATE exam_session SET current_item = $2, answered_domains = $3, reask_count = 0 WHERE id = $1`, examSession.id, nextIdx, answered);
    text = `네, 답변 감사합니다. 다음 질문이에요. ${renderDomainBattery(order[nextIdx])}`;
  }
  if (conversationId) await saveMessages({ conversationId, userId, userContent: ans || "(무응답)", assistantContent: text, skipUserEmbedding: true, skipAssistantEmbedding: true });
  return NextResponse.json({ text, role: "assistant", transcription });
}

/** 3) 날짜/시간 질문 직접 응답 — 음성 경로에서 오면 transcription을 payload에 실어 클라이언트가 사용자 발화를 표시 */
async function handleDateTimeQuestion(userMessage: string, honorific: string, conversationId: string | undefined, userId: string, clientTimeIso?: string, transcription?: string) {
  const timeStr = getCurrentKstDateTimeString(clientTimeIso);
  // honorific 자체가 "할아버지"/"할머니"/"어머니"처럼 이미 친족 호칭이므로
  // "님" 접미 없이 그대로 사용. ("할아버지님" 같은 어색한 호명 방지)
  const replyText = `${honorific}, 지금은 한국 시각으로 ${timeStr}이에요.`;
  if (conversationId) {
    await saveMessages({ conversationId, userId, userContent: userMessage, assistantContent: replyText });
  }
  const payload: Record<string, unknown> = { text: replyText, role: "assistant" };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/** 음성 → 텍스트 변환 (STT 전용) */
async function transcribeAudio(audioData: string, audioMimeType: string): Promise<string> {
  const parts: Part[] = [
    { text: "이 음성을 한국어로 정확하게 받아쓰기하세요. 받아쓰기한 텍스트만 출력하세요. 다른 설명이나 주석은 절대 포함하지 마세요." },
    { inlineData: { mimeType: audioMimeType, data: audioData } },
  ];

  const res = await getGenAI().models.generateContent({
    model: process.env.STT_MODEL || "gemini-2.5-flash", // 비용 최적화: 음성 전사 — 3.5 불필요
    contents: [{ role: "user", parts }],
    // STT가 음성 왕복의 56%(평균 3.7s) 병목 — 전사엔 추론 불필요해 thinking 최소화(0은 빈응답 유발 금지, 64 클램프)
    config: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 64 }, safetySettings: COMPANION_SAFETY_SETTINGS },
  });
  logUsage("stt", res);
  // isUserSpeech: STT 결과는 사용자 발화 — 동반자 출력용 보고체 필터(KO_REPORTIVE)를 적용하면
  // 어르신 간접화법("의사가 약 바꾸라고 한다") 문장이 전사에서 소실됨.
  return extractText(res, { isUserSpeech: true }).trim();
}

/** 4) 음성 요청 — 2단계: STT → 대화 모델 */

/**
 * 스트리밍 응답 — LLM을 generateContentStream으로 받아 문장이 완성될 때마다 SSE로 내보내
 * 클라이언트가 첫 문장부터 바로 말하게 한다(체감 지연 최소화).
 *
 * 안전망: 말해지는(spoken) 문장은 문장단위 postProcessReply로 누출 차단(빈 결과 문장은 skip),
 *        저장·분석되는 canonical 전체 텍스트는 전체 postProcessReply + factCheck로 처리.
 *        (factCheck의 환각-이름 grounding은 전체 기준이라 음성엔 narrow한 잔여 위험 — Stage 2 트레이드오프)
 */
function streamCompanionReply(opts: {
  model: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContentStream: (p: any) => Promise<{ stream: AsyncIterable<{ text: () => string }>; response?: unknown }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContent?: (p: any) => Promise<unknown>;
  };
  contents: unknown;
  fallback: string;
  post: { userText: string; companionName: string; ctx: string; honorific: string; family: FullProfile["family"]; prevAi: string };
  fact: { profile: FullProfile; recentUserText: string; memories: string; honorific: string; companionName: string; currentUserText: string };
  extra?: Record<string, unknown>;
  timings?: Record<string, number>; // 계측(있으면 done에 실어 보냄)
  onComplete: (fullText: string, fallbackUsed: boolean) => Promise<void>;
}): Response {
  const SENTENCE_RE = /[^.!?…。\n]*[.!?…。\n]+/g;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { /* closed */ } };
      // 메타(예: transcription)를 먼저 보내 클라이언트가 사용자 발화를 즉시 표시하게 함
      if (opts.extra && Object.keys(opts.extra).length > 0) send({ type: "meta", ...opts.extra });
      if (opts.timings) opts.timings.genStartMs = Math.round(performance.now() - opts.timings.start);
      let raw = "";
      let buffer = "";
      let spokenAny = false;
      const emitSafe = (sentence: string) => {
        const s = sentence.trim();
        if (!s) return;
        const safe = postProcessReply(s, opts.post).trim();
        if (safe) {
          if (opts.timings && !opts.timings.ttfChunkMs) opts.timings.ttfChunkMs = Math.round(performance.now() - opts.timings.start);
          send({ type: "chunk", text: safe }); spokenAny = true;
        }
      };
      const flush = (final: boolean) => {
        SENTENCE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        let lastEnd = 0;
        while ((m = SENTENCE_RE.exec(buffer)) !== null) { emitSafe(m[0]); lastEnd = SENTENCE_RE.lastIndex; }
        buffer = buffer.slice(lastEnd);
        if (final && buffer.trim()) { emitSafe(buffer); buffer = ""; }
      };
      try {
        let streamErrored = false;
        try {
          const result = await opts.model.generateContentStream(opts.contents);
          for await (const chunk of result.stream) {
            let piece = "";
            try { piece = (typeof chunk.text === "function" ? chunk.text() : "") || ""; } catch { piece = ""; } // 차단/빈 청크에서 throw 방지
            if (!piece) continue;
            raw += piece; buffer += piece;
            flush(false);
          }
          flush(true);
          try { logUsage("companion", await result.response); } catch { /* usage 로깅 best-effort */ }
        } catch (e) {
          streamErrored = true;
          console.warn("[stream] generate error:", (e as Error).message);
        }

        // 스트림이 중도에 끊겼으면 raw를 마지막 완전 문장까지 절단 — 미완 조각("…그런데 오늘")이
        // canonical로 저장·분석되는 것 방지. 완전 문장이 하나도 없으면 빈 문자열 → 아래 재시도로 진입.
        if (streamErrored && raw.trim()) {
          const lastEnd = Math.max(...[...raw.matchAll(/[.!?…。]/g)].map((m) => m.index ?? -1), -1);
          raw = lastEnd >= 0 ? raw.slice(0, lastEnd + 1) : "";
        }

        // 스트림이 비었으면(간헐 빈응답·일시 503) 비스트리밍 1회 재시도 — 폴백률의 직접 원인.
        //   비스트리밍 경로(generateWithFallback)는 원래 2회 시도하는데 스트림 경로만 무재시도였음.
        if (!raw.trim() && typeof opts.model.generateContent === "function") {
          try {
            const retryRes = await opts.model.generateContent(opts.contents);
            logUsage("companion-retry", retryRes);
            raw = extractText(retryRes);
            if (raw.trim()) { buffer = raw; flush(true); } // 재시도 응답도 문장 단위로 발화
          } catch (e2) {
            console.warn("[stream] non-stream retry failed:", (e2 as Error).message);
          }
        }

        // 저장·분석용 canonical 전체 텍스트 — 전체 안전망 + factCheck
        let fullText = raw.trim() ? postProcessReply(raw, opts.post) : "";
        if (fullText.trim()) {
          const fc = factCheckResponse({ aiText: fullText, ...opts.fact });
          if (fc.cleaned !== fullText) { console.warn("[fact-checker:stream] cleaned. removed:", fc.removed.length); fullText = fc.cleaned || fullText; }
        }
        // 폴백 여부를 onComplete에 정확히 전달 — 폴백 멘트가 인지분석·RAG에 들어가 오염되는 것 방지
        let fallbackUsed = false;
        if (!fullText || !fullText.trim()) { fullText = opts.fallback; fallbackUsed = true; }
        if (!spokenAny) send({ type: "chunk", text: fullText }); // 스트림에 아무것도 못 내보냈으면 fallback이라도 말함
        if (opts.timings) opts.timings.totalMs = Math.round(performance.now() - opts.timings.start);
        const includeTiming = opts.timings && process.env.DEBUG_TIMING === "1"; // 측정용(기본 off)
        send({ type: "done", text: fullText, ...(opts.extra || {}), ...(includeTiming ? { timing: opts.timings } : {}) });
        await opts.onComplete(fullText, fallbackUsed).catch((e) => console.error("[stream:onComplete]", e));
      } catch (e) {
        // 후처리·factCheck 등 파이프라인 예외의 마지막 안전망
        console.warn("[stream] pipeline error:", (e as Error).message);
        if (!spokenAny) send({ type: "chunk", text: opts.fallback });
        send({ type: "done", text: opts.fallback, ...(opts.extra || {}) });
        await opts.onComplete(opts.fallback, true).catch((err) => console.error("[stream:onComplete:fallback]", err));
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

async function handleAudioMessage(params: {
  systemPrompt: string; stablePrompt: string; turnBlock: string; envBlock: string; honorific: string; userName: string;
  companionName: string; companionRelation: string;
  userId: string; conversationId?: string;
  sttPromise: Promise<string>; historyText: string;
  messages: { role: string; content: string; createdAt?: string }[];
  profile: FullProfile;
  clientTimeIso?: string;
  timings?: Record<string, number>;
  mode: "user" | "pro" | "general";
}) {
  const { systemPrompt, stablePrompt, turnBlock, envBlock, honorific, companionName, userId, conversationId, sttPromise, historyText, messages, profile, clientTimeIso, timings, mode } = params;

  // 1단계: 음성 → 텍스트 변환 — POST 초입에서 이미 시작됨(프롬프트 빌드와 병렬). 여기선 대기만.
  const transcription0 = await sttPromise;
  if (timings) timings.sttMs = Math.round(performance.now() - timings.start);
  let transcription = transcription0 || "";

  // 1.4단계: 응급 발화 감지 — moderation·STT 게이트보다 먼저 (안전 우선)
  const emergency = await evaluateEmergency({ userContent: transcription, conversationId });
  if (emergency.effectiveLevel === 3) {
    return handleEmergencyL3({
      result: emergency.result, userContent: transcription,
      conversationId, userId, honorific, companionName, transcription,
    });
  }

  // 1.45단계: STT 신뢰도 게이트 — 인식 결과가 잡음/짧음/오인식이면 LLM 우회하고 재질문
  //   응급/모더레이션 매칭이 없는 경우에만 실행. 신뢰도 통과한 발화만 인지 분석에 들어가도록.
  const sttConf = evaluateSttConfidence(transcription);
  if (!sttConf.pass) {
    console.log("[stt-confidence] failed:", sttConf.reason, "txLen:", transcription.length); // PII(발화 원문) 미로깅
    const clarification = buildClarificationReply(honorific, companionName);
    if (conversationId) {
      // 사용자 발화는 잡음/오인식이므로 따로 마커를 붙여 저장 (디버깅용)
      const userTag = transcription && transcription.trim().length > 0
        ? `(STT 저신뢰: ${transcription.trim().slice(0, 60)})`
        : "(음성 메시지 — 인식 실패)";
      await saveMessages({
        conversationId, userId,
        userContent: userTag,
        assistantContent: clarification,
      });
    }
    return NextResponse.json({
      text: clarification, transcription, role: "assistant",
      sttFailed: true, sttReason: sttConf.reason,
    });
  }

  // 1.48단계: 맥락 기반 STT 보정 — 직전 AI 발화 도메인에 맞춰 어휘 교정
  //   "미빈밥" → "비빔밥", "혈양약" → "혈압약" 같은 오인식을 인지 분석기 도달 전에 차단.
  const lastAi = extractLastAiMessage(historyText);
  const correction = correctTranscriptionByContext(transcription, lastAi);
  if (correction.changes.length > 0) {
    if ((process.env.DEBUG_INPUT === "1" && process.env.NODE_ENV !== "production")) {
      // PII(발화 원문) 포함 — DEBUG_INPUT일 때만 출력
      console.log("[stt-context-correction]", JSON.stringify({
        original: transcription,
        corrected: correction.corrected,
        changes: correction.changes,
      }));
    } else {
      console.log("[stt-context-correction]", JSON.stringify({ changeCount: correction.changes.length })); // PII(발화 원문) 미로깅
    }
    transcription = correction.corrected;
  }

  // 1.49단계: T3 마음 건강 체크 — 일반인(general) 전용 (모드 간 플로우 비혼합 원칙: 사용자/전문가=인지 선별, 일반인=정신건강)
  const mentalVoice = mode === "general"
    ? await handleMentalFlow({ userId, userContent: transcription, honorific, companionName })
    : null;
  if (mentalVoice) {
    if (conversationId) {
      await saveMessages({ conversationId, userId, userContent: transcription || "(음성 메시지)", assistantContent: mentalVoice.reply, skipAssistantEmbedding: true, skipUserEmbedding: true });
    }
    return NextResponse.json({ text: mentalVoice.reply, role: "assistant", transcription, mental: mentalVoice.status });
  }

  // 1.5단계: 부적절 발언 감지 + RAG 검색 병렬 실행.
  //   RAG는 transcription(현재 발화) 기준 — 이전엔 STT 전의 직전 턴 텍스트로 검색해 무관한 메모리가 주입됐음.
  const [moderated, memories] = await Promise.all([
    handleInappropriateMessage({
      userContent: transcription,
      conversationId,
      userId,
      honorific,
      companionName,
      transcription,
    }),
    fetchMemories(userId, transcription),
  ]);
  if (moderated) return moderated as NextResponse;

  // 1.55단계: 날짜/시간 질문 단락 — LLM 우회 (음성 "지금 몇 시야" 풀콜 방지).
  //   moderation 뒤에 위치(욕설+시간질문이 거절 카운트를 우회하는 것 방지) +
  //   L1/L2 응급 신호 동반 시("며칠째 잠을 못 자… 지금 몇 시야?") 단락하지 않고 일반 경로로
  //   — emergencyLevel 마킹·L2 보호자 알림·hint 주입이 단락에 삼켜지지 않도록.
  if (transcription && emergency.effectiveLevel === 0 && isDateTimeQuestion(transcription)) {
    return handleDateTimeQuestion(transcription, honorific, conversationId, userId, clientTimeIso, transcription);
  }

  // 2단계: 변환된 텍스트로 대화 모델 호출. info_request만 googleSearch 활성(그 외 비활성, 비용·지연 절감)
  const intent = classifyIntent(transcription);
  const useSearch = intent.intents.includes("info_request");
  // 명시적 프롬프트 캐시(env PROMPT_CACHE=1): 안정 프리픽스를 캐시로, 동적 turnBlock은 contents로. 실패·비활성 시 비캐시 폴백.
  const prefixCache = useSearch ? null : await getPrefixCache(userId, stablePrompt);
  const model = prefixCache ? getTextModel("", useSearch, prefixCache) : getTextModel(systemPrompt, useSearch);
  const repetitionHint = buildRepetitionHint(transcription);
  const wordGameHint = buildWordGameHint(historyText, transcription);
  const nameAnswerHint = buildNameAnswerHint(historyText, transcription);
  const recallVerifyHint = buildRecallVerificationHint(historyText, transcription, companionName);
  const anomalyHint = buildAnomalyCorrectionHint(transcription);
  const familyQueryGuard = buildFamilyQueryGuard(transcription, profile.family);
  const infoRequestHint = buildInfoRequestHint(transcription, companionName);
  const intentHint = buildIntentHint(intent, honorific);
  if (intent.primary !== "daily") {
    console.log("[intent:audio]", JSON.stringify({ primary: intent.primary, all: intent.intents }));
  }
  const recentUserTexts = messages.filter((m) => m.role === "user").slice(-3).map((m) => m.content);
  const hintBlock = [
    intentHint, repetitionHint, wordGameHint, nameAnswerHint, recallVerifyHint, anomalyHint, familyQueryGuard, infoRequestHint, emergency.hint,
    buildEngagementHint(detectLowEngagement(transcription, recentUserTexts)),
  ].filter((s) => s && s.trim()).join("\n\n");
  const currentUserMsg = transcription || "(음성을 인식하지 못했습니다)";
  // 캐시 사용 시 systemInstruction에서 빠진 turnBlock(동적 지시)을 contents 앞에 실어 모델에 전달
  const effectiveHint = prefixCache ? [turnBlock, hintBlock].filter(Boolean).join("\n\n") : hintBlock;
  const contents = buildChatContents({ messages, currentUserMessage: currentUserMsg, memories, hintBlock: effectiveHint });

  const fallback = buildFallbackMessage(honorific, companionName);
  const ctx = `${memories || ""}\n${historyText || ""}\n${transcription || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  const recentUserText = messages.filter((m) => m.role === "user").slice(-6).map((m) => m.content).join(" ");

  // 스트리밍 응답 — 음성도 첫 문장부터 SSE로. transcription은 done 이벤트(extra)로 전달.
  return streamCompanionReply({
    model,
    contents: { contents },
    fallback,
    post: { userText: transcription, companionName, ctx, honorific, family: profile.family, prevAi },
    fact: { profile, recentUserText, memories: memories || "", honorific, companionName, currentUserText: transcription },
    extra: { transcription, ...(emergency.effectiveLevel > 0 ? { emergency: { level: emergency.effectiveLevel, category: emergency.result.category } } : {}) },
    timings,
    onComplete: async (answerText, fallbackUsed) => {
      if (!conversationId) return;
      const { userMsgId } = await saveMessages({
        conversationId, userId,
        userContent: transcription || "(음성 메시지)",
        assistantContent: answerText,
        emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
        emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
        skipAssistantEmbedding: fallbackUsed, // 폴백 멘트는 RAG 오염 방지 위해 임베딩 제외
      });
      if (emergency.effectiveLevel === 2) {
        notifyGuardian({
          userId, userName: honorific, messageId: userMsgId, level: 2,
          category: emergency.result.category, content: transcription, aiReply: answerText, createdAt: new Date(),
        }).then((r) => { if (r.sent) console.log("[emergency-notify] L2 sent:", r.channels); }).catch((e) => console.error("[emergency-notify] L2 error:", e));
      }
      // 폴백 턴에도 인지분석은 수행 — 분석 대상은 사용자 발화이므로 폴백과 무관하게 유효.
      // 단 AI 발화로 폴백 멘트를 넘기면 probe 감지·도메인 자동기록이 오염되므로 빈 문자열로 대체.
      // 일반인(general)은 인지 선별 대상이 아님 — 분석 미수행(목적 분리 + 비용 절감)
      if (mode !== "general") runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: transcription, assistantResponse: fallbackUsed ? "" : answerText, historyText, envBlock, honorific }).catch((e) => console.error("[bg-cognitive]", e));
      if (transcription) {
        extractAndSaveProfile({ userId, userMessage: transcription, userMessageId: userMsgId }).catch((e) => console.error("[bg-profile-extract:audio]", e));
        maybeTriggerSummaryRollup({ userId, conversationId }).catch((e) => console.error("[bg-summary-trigger:audio]", e));
      }
    },
  });
}

/**
 * 응급 발화 감지 — moderation보다 먼저 분기.
 *
 * - L3: LLM 우회 즉시 응급 안내 반환 + Message에 마킹
 * - L2: hint를 호출자에게 반환(LLM 프롬프트에 주입) + Message에 마킹
 * - L1: 24h 누적 ≥3이면 L2로 승격하여 hint 반환, 아니면 마킹만
 * - 0: noop
 */
async function evaluateEmergency(params: {
  userContent: string;
  conversationId: string | undefined;
}): Promise<{ result: EmergencyResult; effectiveLevel: 0 | 1 | 2 | 3; hint: string }> {
  const { userContent, conversationId } = params;
  let result = detectEmergency(userContent);
  // 정규식이 놓친 과소감지 꼬리(사투리·완곡어·어순 변형) — LLM 백스톱.
  //   정규식이 none일 때만 + 사전필터 통과 시에만 LLM 호출(평범한 대화는 비용·지연 0).
  if (result.level === 0) {
    const llm = await detectEmergencyLLM(userContent);
    if (llm) result = llm;
  }
  let effectiveLevel: 0 | 1 | 2 | 3 = result.level;

  // L1이면 누적 평가 후 L2로 승격할지 결정
  if (result.level === 1 && conversationId) {
    const recent = await countRecentL1Signals(conversationId);
    // 현재 발화 1건이 곧 저장될 예정이므로 +1로 평가
    if (shouldEscalateL1ToL2(recent + 1)) effectiveLevel = 2;
  }

  const hint = effectiveLevel === 2 ? buildEmergencyL2Hint(result.category, result.evidence) : "";
  return { result, effectiveLevel, hint };
}

async function handleEmergencyL3(params: {
  result: EmergencyResult;
  userContent: string;
  conversationId: string | undefined;
  userId: string;
  honorific: string;
  companionName: string;
  transcription?: string;
}): Promise<NextResponse> {
  const { result, userContent, conversationId, userId, honorific, companionName, transcription } = params;
  const reply = buildEmergencyL3Reply(honorific, companionName, result.category);

  if (conversationId) {
    const { userMsgId } = await saveMessages({
      conversationId,
      userId,
      userContent: transcription !== undefined ? (transcription || "(음성 메시지)") : userContent,
      assistantContent: reply,
      emergencyLevel: 3,
      emergencyEvidence: `${result.category}:${result.evidence}`,
    });
    // 보호자 알림 — 백그라운드로 발송 (응답 지연 방지)
    notifyGuardian({
      userId,
      userName: honorific,
      messageId: userMsgId,
      level: 3,
      category: result.category,
      content: (transcription ?? userContent) || "",
      aiReply: reply,
      createdAt: new Date(),
    }).then((r) => {
      if (r.sent) console.log("[emergency-notify] L3 sent:", r.channels);
      else console.log("[emergency-notify] L3 skipped:", r.reason);
    }).catch((e) => console.error("[emergency-notify] L3 error:", e));
  }
  const payload: Record<string, unknown> = { text: reply, role: "assistant", emergency: { level: 3, category: result.category } };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/**
 * 부적절 발언 감지 시 LLM 우회. 같은 세션 내 같은 카테고리 발생 횟수를 조회해
 * 단계적 거절 멘트를 반환하고 저장한다.
 *
 * @returns 처리된 경우 NextResponse, 정상 발화면 null
 */
async function handleInappropriateMessage(params: {
  userContent: string;
  conversationId: string | undefined;
  userId: string;
  honorific: string;
  companionName: string;
  transcription?: string;
}): Promise<Response | null> {
  const { userContent, conversationId, userId, honorific, companionName, transcription } = params;
  const moderation = detectInappropriate(userContent);
  if (moderation.category === "ok") return null;

  // 같은 세션에서 이전에 같은 카테고리 거절 멘트가 얼마나 발생했는지 카운트
  let occurrence = 1;
  if (conversationId) {
    const signature = `__mod:${moderation.category}__`;
    const prev = await prisma.message.count({
      where: { conversationId, role: "assistant", content: { contains: signature } },
    });
    occurrence = prev + 1;
  }

  const reply = buildModerationReply(moderation.category, occurrence, honorific, companionName);
  // 저장본은 표시 안 보이는 메타 시그니처를 끝에 붙여 향후 카운트에 사용
  const stored = `${reply}\n<!-- __mod:${moderation.category}__ -->`;

  if (conversationId) {
    await saveMessages({
      conversationId,
      userId,
      userContent: transcription !== undefined ? (transcription || "(음성 메시지)") : userContent,
      assistantContent: stored,
    });
  }
  const payload: Record<string, unknown> = { text: reply, role: "assistant", moderated: moderation.category };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/** 5) 텍스트 요청 (텍스트 모델 — 순수 텍스트 응답) */
async function handleTextMessage(params: {
  systemPrompt: string; stablePrompt: string; turnBlock: string; envBlock: string;
  userId: string; conversationId?: string;
  userContent: string; historyText: string; memories: string;
  messages: { role: string; content: string; createdAt?: string }[];
  companionName: string; companionRelation: string; honorific: string;
  profile: FullProfile;
  timings?: Record<string, number>;
  mode: "user" | "pro" | "general";
}) {
  const { systemPrompt, stablePrompt, turnBlock, envBlock, userId, conversationId, userContent, historyText, memories, messages, companionName, honorific, profile, timings, mode } = params;

  // 응급 발화 감지 — moderation보다 먼저
  const emergency = await evaluateEmergency({ userContent, conversationId });
  if (emergency.effectiveLevel === 3) {
    return handleEmergencyL3({
      result: emergency.result, userContent,
      conversationId, userId, honorific, companionName,
    });
  }

  // T3 마음 건강 체크(PHQ-9 등) — 일반인(general) 전용. 응급(L3) 이후·모더레이션 이전:
  //   9번 문항 답변("죽고 싶다는 생각이 며칠…")이 self_harm 모더레이션에 가로채여 검진이 끊기지 않도록.
  //   검진 턴은 LLM 우회 즉답(JSON) — 정형 문항이라 RAG 임베딩도 제외.
  //   사용자/전문가 모드에선 미작동 — 모드 간 플로우 비혼합 원칙(사용자·전문가=인지 선별, 일반인=정신건강).
  const mental = mode === "general"
    ? await handleMentalFlow({ userId, userContent, honorific, companionName })
    : null;
  if (mental) {
    if (conversationId) {
      await saveMessages({ conversationId, userId, userContent, assistantContent: mental.reply, skipAssistantEmbedding: true, skipUserEmbedding: true });
    }
    return NextResponse.json({ text: mental.reply, role: "assistant", mental: mental.status });
  }

  // 부적절 발언 감지 시 LLM 우회 + 단계적 거절
  const moderated = await handleInappropriateMessage({
    userContent,
    conversationId,
    userId,
    honorific,
    companionName,
  });
  if (moderated) return moderated as NextResponse;

  // 의도 분류 먼저 — info_request(실시간 정보)만 googleSearch 활성, 그 외엔 비활성(비용·지연 절감)
  const intent = classifyIntent(userContent);
  const useSearch = intent.intents.includes("info_request");
  // 명시적 프롬프트 캐시(env PROMPT_CACHE=1): 안정 프리픽스를 캐시로, 동적 turnBlock은 contents로. 실패·비활성 시 비캐시 폴백.
  const prefixCache = useSearch ? null : await getPrefixCache(userId, stablePrompt);
  const model = prefixCache ? getTextModel("", useSearch, prefixCache) : getTextModel(systemPrompt, useSearch);

  const repetitionHint = buildRepetitionHint(userContent);
  const wordGameHint = buildWordGameHint(historyText, userContent);
  const nameAnswerHint = buildNameAnswerHint(historyText, userContent);
  const recallVerifyHint = buildRecallVerificationHint(historyText, userContent, companionName);
  const anomalyHint = buildAnomalyCorrectionHint(userContent);
  const familyQueryGuard = buildFamilyQueryGuard(userContent, profile.family);
  const infoRequestHint = buildInfoRequestHint(userContent, companionName);
  // Phase C: 의도 분류기 — 발화 유형에 따라 prompt 분기 강제 (intent는 위에서 분류)
  const intentHint = buildIntentHint(intent, honorific);
  if (intent.primary !== "daily") {
    console.log("[intent]", JSON.stringify({ primary: intent.primary, all: intent.intents }));
  }
  const recentUserTexts = messages.filter((m) => m.role === "user").slice(-3).map((m) => m.content);
  const hintBlock = [
    intentHint, repetitionHint, wordGameHint, nameAnswerHint, recallVerifyHint, anomalyHint, familyQueryGuard, infoRequestHint, emergency.hint,
    buildEngagementHint(detectLowEngagement(userContent, recentUserTexts)),
  ].filter((s) => s && s.trim()).join("\n\n");

  // 캐시 사용 시 systemInstruction에서 빠진 turnBlock(동적 지시)을 contents 앞에 실어 모델에 전달
  const effectiveHint = prefixCache ? [turnBlock, hintBlock].filter(Boolean).join("\n\n") : hintBlock;
  const contents = buildChatContents({ messages, currentUserMessage: userContent, memories, hintBlock: effectiveHint });

  // DEBUG: 환경변수 DEBUG_INPUT=1 설정 시 입력 dump (사용자 간 데이터 누수 진단용).
  //   2026-05-26 abc→rudtjrch 누수 root cause 추적에 사용됨. 평소엔 off.
  if ((process.env.DEBUG_INPUT === "1" && process.env.NODE_ENV !== "production")) {
    console.log("[DEBUG-INPUT]", JSON.stringify({
      userId: userId.slice(0, 12),
      conversationId: conversationId?.slice(0, 12),
      userContent: userContent.slice(0, 200),
      messagesCount: messages.length,
      memoriesPreview: (memories || "").slice(0, 300),
      systemPromptLen: systemPrompt.length,
      profileFamily: profile.family.map((f) => `${f.relation}#${f.orderIdx ?? '-'} ${f.name}`),
    }, null, 2));
  }

  const fallback = buildFallbackMessage(honorific, companionName);
  const ctx = `${memories || ""}\n${historyText || ""}\n${userContent || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  const recentUserText = messages.filter((m) => m.role === "user").slice(-6).map((m) => m.content).join(" ");

  // 스트리밍 응답 — 첫 문장부터 SSE로 내보내 클라이언트가 바로 말하게 함. 저장·분석은 onComplete(전체 안전망 후).
  return streamCompanionReply({
    model,
    contents: { contents },
    fallback,
    post: { userText: userContent, companionName, ctx, honorific, family: profile.family, prevAi },
    fact: { profile, recentUserText, memories: memories || "", honorific, companionName, currentUserText: userContent },
    extra: emergency.effectiveLevel > 0 ? { emergency: { level: emergency.effectiveLevel, category: emergency.result.category } } : undefined,
    timings,
    onComplete: async (text, fallbackUsed) => {
      if (!conversationId || !userContent) return;
      const { userMsgId } = await saveMessages({
        conversationId, userId, userContent, assistantContent: text,
        emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
        emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
        skipAssistantEmbedding: fallbackUsed, // 폴백 멘트는 RAG 오염 방지 위해 임베딩 제외
      });
      if (emergency.effectiveLevel === 2) {
        notifyGuardian({
          userId, userName: honorific, messageId: userMsgId, level: 2,
          category: emergency.result.category, content: userContent, aiReply: text, createdAt: new Date(),
        }).then((r) => { if (r.sent) console.log("[emergency-notify] L2 sent:", r.channels); }).catch((e) => console.error("[emergency-notify] L2 error:", e));
      }
      // 폴백 턴에도 인지분석은 수행 — 분석 대상은 사용자 발화이므로 폴백과 무관하게 유효.
      // 단 AI 발화로 폴백 멘트를 넘기면 probe 감지·도메인 자동기록이 오염되므로 빈 문자열로 대체.
      // 일반인(general)은 인지 선별 대상이 아님 — 분석 미수행(목적 분리 + 비용 절감)
      if (mode !== "general") runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: userContent, assistantResponse: fallbackUsed ? "" : text, historyText, envBlock, honorific }).catch((e) => console.error("[bg-cognitive]", e));
      extractAndSaveProfile({ userId, userMessage: userContent, userMessageId: userMsgId }).catch((e) => console.error("[bg-profile-extract]", e));
      maybeTriggerSummaryRollup({ userId, conversationId }).catch((e) => console.error("[bg-summary-trigger]", e));
    },
  });
}

// ─── POST ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const parsed = ChatRequestSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
    }
    const body = parsed.data as ChatRequestBody;
    const { messages, conversationId, isInitialGreeting, isReturningGreeting, isReEngage, reEngageAttempt, audio, context: ctx, proxyPatientId } = body;
    const actorId = session.user.id;
    // 모드는 세션의 계정 역할(screeningMode)에서 서버가 결정 — 클라이언트 body.mode는 신뢰하지 않음
    // (user 계정이 mode:"pro"를 보내 표준화 검사 모드를 스푸핑하는 것 차단)
    const mode: "user" | "pro" | "general" =
      session.user.screeningMode === "pro" ? "pro"
      : session.user.screeningMode === "general" ? "general"
      : "user";

    // 건강정보 수집 동의 게이트(API 레벨) — 어르신 본인이 자기 데이터를 생성하는 경우 동의 필수.
    //   UI(app/page.tsx)에서 미동의 시 /consent로 보내지만, /api/chat 직접 호출로 우회되지 않도록 서버에서도 차단.
    if (mode === "user") {
      const me = await prisma.user.findUnique({ where: { id: actorId }, select: { consentedAt: true } });
      if (!me?.consentedAt) {
        return NextResponse.json({ error: "건강정보 수집 동의가 필요합니다.", needConsent: true }, { status: 403 });
      }
    }

    // 전문가 대리 검사 — pro가 연결된 환자를 선택해 검사하면 이력·인지·저장을 환자 계정에 귀속.
    //   보안: pro 계정만, ExpertPatient active 연결 검증. 그 외엔 본인(actor)에 귀속.
    let userId = actorId;
    if (proxyPatientId && proxyPatientId !== actorId) {
      if (mode !== "pro") {
        return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
      }
      const link = await prisma.expertPatient.findUnique({
        where: { expertUserId_patientUserId: { expertUserId: actorId, patientUserId: proxyPatientId } },
        select: { status: true },
      });
      if (!link || link.status !== "active") {
        return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });
      }
      // 일반인(general) 환자는 인지선별 비대상 — 대리 경로로 인지 데이터가 기록되지 않도록 차단(목적 분리)
      const pat = await prisma.user.findUnique({ where: { id: proxyPatientId }, select: { screeningMode: true } });
      if (pat?.screeningMode === "general") {
        return NextResponse.json({ error: "일반인 계정은 대리 검사 대상이 아닙니다." }, { status: 400 });
      }
      userId = proxyPatientId;
    }

    // 전문가 검진 상태머신 — 대리 검사 중 진행 세션이 있으면 항목단위 검진으로 라우팅
    const examSession = (proxyPatientId && mode === "pro") ? await lookupOpenExam(actorId, proxyPatientId) : null;

    // 고비용 엔드포인트 폭주 방어 — 행위 주체(전문가/본인) 기준 분당 40회 (대리 검사 다환자 남용도 차단)
    const rl = await checkRateLimit(`chat:${actorId}`, 40, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "잠시 후 다시 시도해주세요." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    // conversationId 소유권 검증 — 타 사용자 대화 ID로 이력 열람·메시지 주입 차단(명시적 authz)
    if (conversationId) {
      const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } });
      if (!owned) {
        return NextResponse.json({ error: "잘못된 대화입니다." }, { status: 403 });
      }
    }

    const _t: Record<string, number> = { start: performance.now() };
    const timeCtx = getTimeContext(ctx?.currentTime);
    const isAudio = !!(audio?.data && audio?.mimeType);
    const userMessages = messages?.filter((m) => m.role === "user").map((m) => m.content) ?? [];
    const lastUserMessage = userMessages[userMessages.length - 1] ?? "";

    // 음성 STT를 가장 먼저 시작 — weather/프롬프트/이력 조회와 병렬로 진행해 음성 왕복 지연 단축.
    //   (STT는 시스템 프롬프트와 무관하므로 직렬일 이유가 없음. 실패는 핸들러에서 빈 전사로 처리)
    const sttPromise = isAudio && audio
      ? transcribeAudio(audio.data, audio.mimeType).catch((e) => { console.warn("[STT] transcription failed:", e); return ""; })
      : null;

    // weather · RAG(임베딩 HTTP) · DB 이력은 상호 독립 — 병렬화로 LLM 호출 전 선행 지연 절감.
    //   인사 턴은 RAG 불필요, 음성 턴은 STT 후 transcription 기준으로 핸들러가 직접 검색.
    const skipMemories = isInitialGreeting || isReturningGreeting || isReEngage || isAudio || !lastUserMessage;
    let _m = performance.now();
    const [weatherCtx, memories, dbHistory] = await Promise.all([
      getWeatherContext(ctx?.latitude, ctx?.longitude),
      skipMemories ? Promise.resolve("") : fetchMemories(userId, lastUserMessage),
      conversationId && !isInitialGreeting ? fetchRecentHistory(conversationId) : Promise.resolve([]),
    ]);
    _t.weatherMs = Math.round(performance.now() - _m);
    // DB 이력이 있으면 그것이 ground truth (클라이언트 slice 50·미저장 경합 시에만 폴백)
    const history = dbHistory.length > 0 ? dbHistory : (messages ?? []);
    _m = performance.now();
    const { systemPrompt, stablePrompt, turnBlock, envBlock, userName, honorific, companionName, companionRelation, profile } = await buildSystemPrompt({
      userId, conversationId, timeCtx, weather: weatherCtx, mode,
    });
    _t.promptMs = Math.round(performance.now() - _m);

    // 검진 시작(대리 검사) — 자동 인사 대신 표준 문항 시행 시작
    if (isInitialGreeting && examSession) {
      return handleExamGreeting(examSession, conversationId, new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10));
    }
    if (isInitialGreeting) return handleFirstGreeting(systemPrompt, userName, honorific, companionName, companionRelation, conversationId);
    if (isReturningGreeting) return handleReturningGreeting(systemPrompt, userName, honorific, conversationId, userId, mode);
    if (isReEngage) return handleReEngageGreeting(systemPrompt, honorific, companionName, history, conversationId, reEngageAttempt ?? 1);

    // 검진 진행 턴 — 진행 중 검진 세션이 있으면 항목단위 채점 경로로(일상 대화·인지분석 우회)
    if (examSession && examSession.item_order) {
      if (isAudio && sttPromise) {
        const tr = (await sttPromise.catch(() => "")) || "";
        return handleExamTurn({ examSession, answer: tr, conversationId, userId, transcription: tr || "(음성 응답)" });
      }
      if (lastUserMessage) return handleExamTurn({ examSession, answer: lastUserMessage, conversationId, userId });
    }

    const historyText = buildHistoryText(history);

    // 응급 신호(L1 이상)나 부적절 발언이 섞인 발화는 단락하지 않고 일반 경로로 —
    // 시간 즉답이 응급 마킹/누적·모더레이션 카운트를 삼키는 것 방지(음성 1.55단계와 동일 정책).
    if (!isAudio && lastUserMessage && isDateTimeQuestion(lastUserMessage)
      && detectEmergency(lastUserMessage).level === 0
      && detectInappropriate(lastUserMessage).category === "ok") {
      return handleDateTimeQuestion(lastUserMessage, honorific, conversationId, userId, ctx?.currentTime);
    }

    if (isAudio && sttPromise) {
      return handleAudioMessage({
        systemPrompt, stablePrompt, turnBlock, envBlock, honorific, userName, companionName, companionRelation, userId, conversationId,
        sttPromise, historyText, messages: history, profile,
        clientTimeIso: ctx?.currentTime, timings: _t, mode,
      });
    }

    return handleTextMessage({ systemPrompt, stablePrompt, turnBlock, envBlock, userId, conversationId, userContent: lastUserMessage, historyText, memories, messages: history, companionName, companionRelation, honorific, profile, timings: _t, mode });
  } catch (e) {
    console.error("chat api error", e);
    return NextResponse.json({ error: toSafeError(e) }, { status: 500 });
  }
}
