/**
 * T3 검진 세션 상태 머신 — "마음 건강 체크" 대화형 PHQ-9 진행.
 *
 * 상태: mental_session.current_item — 0=동의 대기, 1~9=해당 문항 답변 대기. status active|done|aborted.
 * 설계 원칙(docs/T3_정신건강_설계.md):
 *  - 검진 턴은 LLM 동반자를 우회(정형 문항·즉답) — 빠르고 결정적
 *  - 응답 원문 비보존(점수만) · 문항별 점수 비노출 · 결과는 본인만
 *  - 9번(자해사고) 점수 ≥1 → 합계 무관 즉시 위기 안내
 *  - 호출 위치: 응급 감지(L3) 이후, 모더레이션 이전 — 9번 답변("죽고 싶다는 생각…")이
 *    self_harm 모더레이션에 가로채여 검진이 끊기지 않도록. 실제 위급(L3)은 여전히 우선.
 */
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { SCALES, CRISIS_GUIDE, NON_DIAGNOSTIC_NOTICE, type MentalItem } from "@/lib/screening/mental-bank";
import { classifyAnswer } from "@/lib/health/mental-scorer";

const GAD7_TRIGGER_RE = /불안\s*(?:체크|검사|검진|테스트)/;
const UCLA3_TRIGGER_RE = /외로움\s*(?:체크|검사|검진|테스트)/;
const BFI10_TRIGGER_RE = /성격\s*(?:체크|검사|검진|테스트|알아보)/;
const TRIGGER_RE = /마음\s*(?:건강)?\s*(?:체크|검진|검사)|우울\s*(?:검사|체크|테스트|검진)|정신\s*건강\s*(?:체크|검사|검진)/;
// 과거 경험 서술("병원에서 우울 검사 받았어")은 시작 의도가 아님 — 오발동 가드
const TRIGGER_PAST_RE = /받았|했었|했어|했지|했거든|다녀왔|다녀온|끝났|해\s*봤/; // \b는 한글에 무력 — 사용 금지(기지 버그 클래스)
// bare '두/관두'는 "그만두면 신경 쓰여요"(서술) 같은 정상 답변을 중단으로 오인(死정규식 클래스, 2026-06-15 BFI-10 라이브 FP).
//   연결어미 면/고/니 앞이면 중단 의사가 아니라 서술 → 부정 lookahead로 제외. "그만둬(둬)/그만둘래"는 그대로 매칭.
const ESCAPE_RE = /그만\s*(?:할|하|둬|두(?!면|고|니))|안\s*할(?:래|게)|나중에\s*(?:할|하)|중단|취소|스톱|관두(?!면|고|니)/;
/** 중단 의사 감지 (회귀 테스트 노출 — 순수 함수). */
export const isAbortIntent = (t: string): boolean => ESCAPE_RE.test(t || "");
const AFFIRM_RE = /응|어\s|그래|네|예\b|좋아|좋지|시작|해\s*보자|하자|할래|해\s*줘|그러자|오냐|궁금/;
// 동의 단계에서 검진을 화제로 삼고 있는지(질문·망설임 포함) — 미해당이면 딴 주제로 보고 비켜남
const CONSENT_TOPIC_RE = /검사|체크|점검|테스트|우울|불안|성격|외로|마음|점수|결과|질문|뭐|뭔|어떻|왜|무슨|몇\s*(?:개|가지)|무서|걱정|부담|싫|글쎄|괜찮|고민/;
// 검진 '결과/점수' 요청 — 진행 중 세션이 없을 때 LLM이 가짜 결과를 지어내지 않도록 결정적 안내로 가로챔.
const RESULT_REQUEST_RE = /(?:검사|검진|체크|점검|우울|불안|외로움|성격|마음\s*건강)\s*(?:결과|점수|등급|레벨)|(?:결과|점수)\s*(?:가|는|은|이)?\s*(?:어때|어떻게|뭐|보여|알려|나왔|나와|궁금)/;
/** 검진 결과 요청 감지 (회귀 테스트용 순수 함수). */
export const isMentalResultRequest = (t: string): boolean => RESULT_REQUEST_RE.test(t || "");

interface MentalSession {
  id: string; scale: string; status: string; current_item: number; retry_used: boolean;
}

export interface MentalFlowResult {
  reply: string;
  status: "started" | "in_progress" | "retry" | "aborted" | "done";
  crisis?: boolean;
}

const ACK_BY_SCORE = [
  "다행이에요.",
  "그런 날이 좀 있으셨군요.",
  "적지 않게 힘드셨겠어요.",
  "많이 힘드셨겠어요. 말씀해 주셔서 고마워요.",
];

/** answerType별 수긍 멘트 — 증상 빈도(freq4/freq3)는 공감형, 성격 동의(agree5)는 중립형(좋고 나쁨 없음) */
function ackFor(answerType: string, score: number): string {
  if (answerType === "agree5") {
    return ["그렇진 않으시군요.", "조금은 아니시군요.", "중간쯤이시군요.", "그런 편이시군요.", "확실히 그러시군요."][score] ?? "알겠어요.";
  }
  if (answerType === "freq3") {
    return ["다행이에요.", "가끔 그러시는군요.", "자주 그러셨다니 마음이 쓰여요."][score - 1] ?? "알겠어요.";
  }
  return ACK_BY_SCORE[score] ?? "알겠어요.";
}

function askItem(items: MentalItem[], no: number, variantIdx = 0): string {
  const item = items[no - 1];
  const v = item.variants[variantIdx % item.variants.length];
  return `${no}/${items.length}. ${v}`;
}

async function getActiveSession(userId: string): Promise<MentalSession | null> {
  // 30분 이상 방치된 active 세션은 lazy 만료
  await prisma.$executeRawUnsafe(
    `UPDATE mental_session SET status = 'aborted', updated_at = now()
      WHERE user_id = $1 AND status = 'active' AND updated_at < now() - INTERVAL '30 minutes'`, userId);
  const rows = await prisma.$queryRawUnsafe<MentalSession[]>(
    `SELECT id, scale, status, current_item, retry_used FROM mental_session
      WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`, userId);
  return rows[0] ?? null;
}

const setSession = (id: string, fields: string, ...vals: unknown[]) =>
  prisma.$executeRawUnsafe(`UPDATE mental_session SET ${fields}, updated_at = now() WHERE id = $1`, id, ...vals);

/**
 * 검진 플로우 처리. 검진과 무관한 턴이면 null(일반 대화로 진행).
 */
export async function handleMentalFlow(params: {
  userId: string;
  userContent: string;
  honorific: string;
  companionName: string;
}): Promise<MentalFlowResult | null> {
  const { userId, userContent, honorific, companionName } = params;
  const session = await getActiveSession(userId);

  // ── 세션 없음: 트리거 발화면 시작(동의 단계) — 과거 경험 서술은 제외
  if (!session) {
    const scaleKey = UCLA3_TRIGGER_RE.test(userContent) ? "UCLA3"
      : BFI10_TRIGGER_RE.test(userContent) ? "BFI10"
      : GAD7_TRIGGER_RE.test(userContent) ? "GAD7"
      : TRIGGER_RE.test(userContent) ? "PHQ9" : null;
    const isStart = !!scaleKey && !TRIGGER_PAST_RE.test(userContent);
    if (!isStart) {
      // 시작 트리거가 아닌데 '결과/점수' 요청이면 — 진행 중 세션이 없으므로 LLM 환각(가짜 결과) 방지용 결정적 안내.
      if (RESULT_REQUEST_RE.test(userContent) && !TRIGGER_PAST_RE.test(userContent)) {
        const doneRows = await prisma.$queryRawUnsafe<{ scale: string }[]>(
          `SELECT scale FROM mental_session WHERE user_id = $1 AND status = 'done' ORDER BY updated_at DESC LIMIT 1`, userId);
        if (doneRows.length > 0) {
          return { status: "done", reply: `${honorific}, 지난 점검 결과는 "마음 건강" 페이지에서 ${honorific}만 보실 수 있어요. 점수를 대신 말씀드리진 않지만, 요즘 마음이 어떠신지는 언제든 같이 이야기해요.` };
        }
        return { status: "aborted", reply: `${honorific}, 아직 마음 건강 점검을 끝내지 않으셨어요. 지금 해보고 싶으시면 "마음 건강 체크"라고 말씀해 주세요.` };
      }
      return null;
    }
    const scale = SCALES[scaleKey];
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO mental_session (id, user_id, scale, status, current_item) VALUES ($1, $2, $3, 'active', 0)`, id, userId, scaleKey);
    const aboutLine = scaleKey === "BFI10"
      ? `평소 본인의 모습에 대해 ${scale.items.length}가지를 여쭤보고`
      : scaleKey === "UCLA3"
        ? `요즘 느끼시는 것에 대해 ${scale.items.length}가지를 여쭤보고`
        : `최근 2주간의 기분에 대해 ${scale.items.length}가지를 여쭤보고`;
    return {
      status: "started",
      reply: `${honorific}, ${scale.name} 자가 점검을 시작할게요. ${aboutLine}, 끝나면 결과를 ${honorific}께만 보여드려요. 중간에 "그만할래"라고 하시면 언제든 멈출 수 있어요. 시작해 볼까요?`,
    };
  }

  const scale = SCALES[session.scale] ?? SCALES.PHQ9;
  const items = scale.items;

  // ── 중단 의사
  if (ESCAPE_RE.test(userContent)) {
    await setSession(session.id, `status = 'aborted'`);
    return { status: "aborted", reply: `알겠어요 ${honorific}, 부담 갖지 마세요. 하고 싶어지실 때 "마음 건강 체크"라고 말씀해 주시면 언제든 다시 시작할게요.` };
  }

  // ── 동의 단계 (current_item = 0)
  if (session.current_item === 0) {
    if (AFFIRM_RE.test(userContent)) {
      await setSession(session.id, `current_item = 1, retry_used = false`);
      return { status: "in_progress", reply: `좋아요, 편하게 답해 주세요. ${scale.answerGuide}\n\n${askItem(items, 1)}` };
    }
    // 딴 주제 발화("그 전에 손주 전화 온다고 했나?") — 검진이 대화를 가로채지 않도록
    // 조용히 세션을 접고 일반 대화로 위임. 원하면 트리거로 다시 시작.
    if (userContent.length >= 10 && !CONSENT_TOPIC_RE.test(userContent)) {
      await setSession(session.id, `status = 'aborted'`);
      return null;
    }
    if (!session.retry_used) {
      await setSession(session.id, `retry_used = true`);
      return { status: "retry", reply: `표준 자가 점검(${scale.name})을 대화로 풀어서 여쭤보는 거예요. 결과는 ${honorific}만 보실 수 있고, 진단이 아닌 참고용이에요. 시작해 볼까요? (싫으시면 "그만할래"라고 해주세요)` };
    }
    await setSession(session.id, `status = 'aborted'`);
    return { status: "aborted", reply: `알겠어요, 오늘은 여기까지 할게요. 마음 내키실 때 "마음 건강 체크"라고 불러주세요.` };
  }

  // ── 문항 답변 단계
  const itemNo = session.current_item;
  const item = items[itemNo - 1];
  const rawScore = await classifyAnswer(userContent, scale.answerType);

  if (rawScore < 0) {
    if (!session.retry_used) {
      await setSession(session.id, `retry_used = true`);
      return { status: "retry", reply: `${nameSoft(companionName)} 다시 한번 여쭤볼게요. ${scale.answerGuide}\n\n${askItem(items, itemNo, 1)}` };
    }
    await setSession(session.id, `status = 'aborted'`);
    return { status: "aborted", reply: `답하기 애매한 질문이었나 봐요. 오늘은 여기서 멈출게요 — 나중에 "마음 건강 체크"로 다시 이어가요.` };
  }

  // 역채점 문항(BFI-10)은 진점수로 뒤집어 저장 — 결과 산출 시 추가 변환 불필요
  const maxScore = scale.answerType === "agree5" ? 4 : 3;
  const score = item.reverse ? maxScore - rawScore : rawScore;

  // 점수 저장 (원문 비보존, 멱등)
  await prisma.$executeRawUnsafe(
    `INSERT INTO mental_assessments (id, session_id, user_id, item_no, score)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (session_id, item_no) DO UPDATE SET score = EXCLUDED.score`,
    `ma_${session.id}_${itemNo}`, session.id, userId, itemNo, score);

  const crisis = !!item.crisis && score >= 1;
  const crisisLine = crisis ? `\n\n${CRISIS_GUIDE}` : "";
  const ack = ackFor(scale.answerType, rawScore); // 수긍 멘트는 사용자가 말한 그대로(역채점 전) 기준

  // ── 마지막 문항이면 결과 산출
  if (itemNo >= items.length) {
    const rows = await prisma.$queryRawUnsafe<{ item_no: number; score: number; total: number }[]>(
      `SELECT item_no, score, SUM(score) OVER ()::int AS total FROM mental_assessments WHERE session_id = $1`, session.id);
    const total = rows[0]?.total ?? 0;
    const interp = scale.interpretItems
      ? scale.interpretItems(rows.map((r) => ({ itemNo: r.item_no, score: r.score })))
      : scale.interpret(total);
    await setSession(session.id, `status = 'done', total = $2, severity = $3, crisis = $4`, total, interp.severity, crisis);
    const recommendLine = interp.recommend ? " 가까운 정신건강복지센터(1577-0199)나 병원에서 상담받아 보시길 권해요." : "";
    // 9번 양성 후속 케어: 결과 직후 대화를 닫지 않고 마음을 더 나누도록 초대 (보호자 알림은 본인 동의 없인 금지 — T3 원칙)
    const careLine = crisis ? `\n${honorific}, 괜찮으시면 지금 마음이 어떤지 ${companionName}한테 조금 더 이야기해 주세요. 끝까지 들어드릴게요.` : "";
    const crossLine = session.scale === "PHQ9" ? `\n불안 점검도 해보고 싶으시면 "불안 체크"라고 말씀해 주세요.` : "";
    const resultLine = scale.interpretItems
      ? `${interp.text}` // 프로파일형(BFI-10) — 등급 표현 없이 프로파일 그대로
      : `이번 점검 결과는 「${interp.severity}」이에요. ${interp.text}${recommendLine}`;
    return {
      status: "done", crisis,
      reply: `${ack}${crisisLine}\n\n${honorific}, ${items.length}가지 모두 답해 주셔서 고마워요. ${resultLine}\n자세한 결과와 지난 기록은 "마음 건강" 페이지에서 ${honorific}만 보실 수 있어요. ${NON_DIAGNOSTIC_NOTICE}${careLine}${crossLine}`,
    };
  }

  // ── 다음 문항
  await setSession(session.id, `current_item = $2, retry_used = false`, itemNo + 1);
  return { status: "in_progress", crisis, reply: `${ack}${crisisLine}\n\n${askItem(items, itemNo + 1)}` };
}

function nameSoft(companionName: string): string {
  return companionName ? `${companionName}가` : "제가";
}
