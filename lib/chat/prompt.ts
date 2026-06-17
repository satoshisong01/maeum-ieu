/** 프롬프트 조립 */

import type { TimeContext, WeatherContext, ScreeningMode } from "./types";
import { renderSystemPrompt, COMPANION_DEFAULTS } from "./constants";
import { prisma } from "@/lib/prisma";
import { toKstDateString } from "./time";
import { getFullProfile, renderProfileForPrompt, type FullProfile } from "./profile";
import { getRecentSummaries, renderSummariesForPrompt } from "./summarizer";
import { sampleQuestionsForDomain, isBankReady } from "@/lib/screening/question-bank";
import { getCognitiveTierForPrompt, buildCognitiveAdaptationHint, type CognitiveTierResult } from "@/lib/health/cognitive-level";

/**
 * 사용자 호칭 결정. age/gender null이면 "선생님" — "회원님"은 prompt에서 금지된 단어라 fallback에 쓰면 안 됨.
 * (시스템 prompt와 코드 fallback 일관성 유지)
 */
export function getHonorific(age: number | null, gender: string | null): string {
  if (age == null || gender == null) return "선생님";
  if (age >= 60) return gender === "male" ? "할아버지" : gender === "female" ? "할머니" : "선생님";
  if (age >= 40) return gender === "male" ? "아빠" : gender === "female" ? "엄마" : "선생님";
  return "선생님";
}

function buildEnvBlock(timeCtx: TimeContext, weather: WeatherContext): string {
  return `[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]
- 현재 한국 시각: ${timeCtx.dateStr}
- 시간대: ${timeCtx.timeLabel}
- ${weather.promptText}

날짜/요일/시각을 말할 때는 반드시 위 정보를 사용하세요. 자체 추측 금지.`;
}

async function getDateAwareBlock(conversationId: string, todayKst: string): Promise<string> {
  const last = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return "";
  const lastDate = toKstDateString(last.createdAt);
  if (lastDate === todayKst) return "";
  return `\n[날짜 안내] 마지막 대화는 ${lastDate}이었고, 오늘은 ${todayKst}입니다. 오늘 기준으로 식사/활동을 물어보세요.`;
}

async function getTodayAssessedDomains(userId: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ domain: string }[]>(
      `SELECT DISTINCT domain FROM cognitive_assessments WHERE user_id = $1 AND session_date = $2::date`,
      userId, toKstDateString(new Date()),
    );
    return rows.map((r) => r.domain);
  } catch { return []; }
}

/**
 * 전문가(검사 시행) 모드 가이드 — 공신력 있는 표준 인지선별(MMSE-K/MoCA-K) 문항을 변형 없이 그대로,
 * 정해진 순서로 한 문항씩 시행. 의사·관리사가 사람이 하던 검사를 대신/보조하는 용도.
 * (음성으로 시행 가능한 항목만; 시공간 구성·읽기·쓰기·그리기는 음성 불가라 제외.)
 */
function buildProGuideBlock(companionName: string, completedKo: string[], remainingKo: string[], remainingCount: number): string {
  if (remainingCount === 0) {
    return `\n[검사 시행 모드 — 오늘 표준 인지선별 항목 시행 완료]
오늘 음성으로 시행 가능한 7개 영역 평가가 모두 끝났습니다. **추가 인지 문항을 출제하지 말고**, "오늘 검사는 여기까지입니다, 수고하셨습니다" 정도의 짧은 마무리만 하세요.`;
  }
  return `\n[검사 시행 모드 — 표준화 인지선별 검사 (전문가·관리사용). 반드시 준수]
지금 ${companionName}은(는) 친근한 잡담 동반자가 아니라, **표준화된 인지선별 검사(MMSE-K/MoCA-K)를 시행하는 검사자**입니다.
⛔ 이 모드에서 정신건강 자가점검("마음 건강 체크"/우울·불안·외로움·성격 검사)은 **언급·제안·재개하지 않습니다** — 과거 대화에 흔적이 있어도 무시하세요(계정 유형별 기능 분리).

**시행 원칙(엄수)**
1. 공감·잡담은 한 문장 이내로 최소화. **한 응답에 딱 한 문항만** 또렷하고 정확하게 질문한다.
2. 아래 표준 문항을 **그대로** 읽는다. 임의로 쉽게 바꾸거나, 보기를 주거나, 힌트를 주지 않는다.
3. 사용자가 답하면 정답 여부를 평가하거나 알려주지 않는다(채점은 시스템이 함). "네", "다음 질문 드리겠습니다" 정도로 중립적으로 받고 바로 다음 문항으로.
4. 회상 문항에서 사용자가 못 맞혀도 **정답을 알려주지 않는다**(검사 무효화 방지).
5. 정해진 순서대로 진행한다.

**오늘 이미 시행한 영역(다시 묻지 말 것)**: ${completedKo.length ? completedKo.join(", ") : "없음"}
**다음 시행할 영역(이 순서대로 하나씩)**: ${remainingKo.join(" → ")}

**표준 문항(해당 영역 차례에 그대로 사용)**
- 시간 지남력: "올해가 몇 년도입니까? 지금은 무슨 계절입니까? 몇 월 며칠이고 무슨 요일입니까?"
- 장소 지남력: "지금 계신 곳이 어디입니까? 무슨 시·도이고, 어떤 장소(집/병원 등)입니까?"
- 즉시 기억(등록): "지금부터 단어 세 개를 불러드리겠습니다. 끝까지 듣고 따라 말씀하신 뒤 기억해 두세요. ‘나무, 자동차, 모자’. 따라 해 보세요."
- 주의·계산: "100에서 7을 빼면 얼마입니까? 거기서 또 7을 빼면요? (계속 7씩 빼서 다섯 번까지)" (또는 "‘삼천리강산’을 거꾸로 말씀해 보세요.")
- 지연 기억(회상): "조금 전에 외워 두시라고 말씀드린 단어 세 개가 무엇이었습니까?"
- 언어: "1분 동안 생각나는 동물 이름을 최대한 많이 말씀해 보세요." / "제가 말하는 문장을 그대로 따라 해 보세요: ‘백문이 불여일견’."
- 판단력: "길에서 다른 사람의 주민등록증을 주우셨다면 어떻게 하시겠습니까?"`;
}

export interface PromptParts {
  systemPrompt: string;
  envBlock: string;
  userName: string;
  honorific: string;
  companionName: string;
  companionRelation: string;
  profile: FullProfile;
}

export async function buildSystemPrompt(params: {
  userId: string;
  conversationId?: string;
  timeCtx: TimeContext;
  weather: WeatherContext;
  mode?: ScreeningMode;
}): Promise<PromptParts> {
  const { userId, conversationId, timeCtx, weather, mode = "user" } = params;
  const todayKstEarly = toKstDateString(new Date());

  // 5개 DB 조회가 전부 상호 독립 — 순차 5 RTT → 병렬 1 RTT (선행 지연 ~150-300ms 절감, 2026-06-11)
  const [user, dateBlockP, assessedP, userMsgCount, profile, summaries, cogTier] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, age: true, gender: true, companionName: true, companionRelation: true, userHonorific: true },
    }),
    conversationId ? getDateAwareBlock(conversationId, todayKstEarly) : Promise.resolve(""),
    getTodayAssessedDomains(userId),
    conversationId && mode !== "pro"
      ? prisma.message.count({ where: { conversationId, role: "user" } })
      : Promise.resolve(0),
    getFullProfile(userId),
    getRecentSummaries(userId),
    // 인지 등급 적응은 사용자 모드 전용 — pro(검사자, 표준문항 그대로)·general(인지선별 없음)은 미적용·비용 절감
    mode === "user" ? getCognitiveTierForPrompt(userId) : Promise.resolve({ tier: "평가전", avg: -1 } as CognitiveTierResult),
  ]);
  const userName = user?.name?.trim() || "사용자";
  const honorific = user?.userHonorific?.trim() || getHonorific(user?.age ?? null, user?.gender ?? null);
  const companionName = user?.companionName?.trim() || COMPANION_DEFAULTS.name;
  const companionRelation = user?.companionRelation?.trim() || COMPANION_DEFAULTS.relation;

  // 금지 호칭 목록 — userHonorific으로 사용 중인 호칭은 제외 (모순 방지)
  const FORBIDDEN_POOL = ["회원님", "고객님", "선생님", "사장님", "어르신"];
  const forbidden = FORBIDDEN_POOL.filter((h) => h !== honorific).join("/");
  const userBlock = `[사용자 정보 — 호칭 절대 규칙]
- 이름: ${userName}
- **사용자 호칭: ${honorific}** (이 호칭만 사용. "${forbidden}" 절대 금지. 한 대화 안에서 호칭을 바꾸지 말 것.)
- AI 동반자: ${companionName} (${companionRelation})
- AI는 자기 자신을 ${companionName}이라고만 부르고, 사용자는 항상 ${honorific}으로만 부른다.
- ⚠ **호명 빈도**: 응답은 **기본적으로 호칭 없이 바로 본문으로 시작**하세요. "${honorific},"로 시작하는 건 대화 4~5번에 한 번, 감정을 담아 부를 때만. (문장 중간에 호칭을 자연스럽게 섞는 건 자유)${user?.gender === "female" ? `\n- 친족어는 **여성 화자 기준**: 손위 형제는 "오빠/언니" (❌ "형/누나" 금지 — 사용자는 여성)` : user?.gender === "male" ? `\n- 친족어는 **남성 화자 기준**: 손위 형제는 "형/누나" (❌ "오빠/언니" 금지 — 사용자는 남성)` : ""}

[사용자 가족·자녀 호칭 — 매우 중요, 절대 어기지 마세요]
사용자가 자녀를 친근한 이름 형태(예: "○○이/○○/큰아들/둘째") 처럼 부르면 AI도 **그 호칭 그대로** 사용. 자녀에게 "씨" 절대 붙이지 마세요.
- ❌ 절대 금지: "○○ 씨", "큰아드님 씨", "따님 씨" 같은 "이름 + 씨" 형태
- ✅ 허용: "○○이", "○○", "○○ 아드님", "○○ 따님", "○○님", "큰아드님", "둘째 아드님"
- ⛔ 가족·자녀 이름은 [참고 — 과거 메모리]나 [사용자 확정 정보]에 있는 이름만 사용. 거기에 없는 이름은 절대 추측·언급하지 마세요.
- 과거 대화 이력에 "OO 씨"가 보이더라도 그 패턴 따라하지 마세요. 한국에서 부모가 자식에게 "씨" 붙이는 건 매우 부자연스럽고 거리감을 줍니다.
- ⛔ **"${honorific}" 호칭은 오직 사용자 본인에게만** 씁니다. 사용자가 언급하는 **다른 사람(부모·고인·자녀·이웃·유명인 등)에게 "${honorific}"을 붙이거나 그 호칭으로 바꿔 부르지 마세요.**
  · 사용자 "돌아가신 우리 어머니" → AI도 "어머니"(❌ "${honorific}"으로 바꾸면 누구인지 헷갈림)
  · 사용자 "어머니가 해주시는 닭갈비" → AI도 "어머님이 해주시는"(❌ "${honorific}께서 해주시는" — 행위 주체가 뒤바뀜. 직전 발화 속 인물 지칭(어머니/아버지/오빠 등)은 **그대로 유지**)
  · 사용자 "이미자, 나훈아 노래" → "이미자", "나훈아"(❌ "이미자 ${honorific}", "나훈아 ${honorific}")
  · 사용자 친구 "순자" 처럼 실제 어르신이면 "순자 할머니"는 허용.`;
  const envBlock = buildEnvBlock(timeCtx, weather);
  const dateBlock = dateBlockP;
  const assessed = assessedP;
  const allDomains = ["orientation_time", "orientation_place", "memory_immediate", "memory_delayed", "language", "judgment", "attention_calculation"];

  const DOMAIN_KO: Record<string, string> = {
    orientation_time: "시간 지남력 (요일/날짜/계절)",
    orientation_place: "장소 지남력 (현재 위치)",
    memory_immediate: "즉시 기억력 (방금 한 말)",
    memory_delayed: "지연 기억력 (과거 대화 내용)",
    language: "언어 능력 (단어 찾기 게임 등)",
    judgment: "판단력 (상황 판단 질문)",
    attention_calculation: "주의력/계산 (암산, 숫자 게임)",
  };

  const remaining = allDomains.filter((d) => !assessed.includes(d));
  const completedKo = assessed.map((d) => DOMAIN_KO[d] || d);
  const remainingKo = remaining.map((d) => DOMAIN_KO[d] || d);

  let guideBlock: string;
  // 인지 프로토콜(질문 풀 ~6.6k자) 주입 여부 — 필요한 턴에만:
  //   · 사용자 모드 수다 턴: guideBlock이 "인지 질문 금지"를 지시하는데 질문 풀을 통째 주입하면 모순 + 토큰 낭비
  //   · 전문가 모드: proGuideBlock이 표준 문항·정답 비노출 규칙을 자체 포함하며, 프로토콜의 "자연스러운 수다" 지시와 충돌
  //   (회상 정답 노출 방어는 턴 단위 hint(buildRecallVerificationHint) + 후처리(stripRecallAnswerLeak)가 별도 담당)
  let includeProtocol = false;
  if (mode === "pro") {
    guideBlock = buildProGuideBlock(companionName, completedKo, remainingKo, remaining.length);
  } else if (mode === "general") {
    // 일반인 모드 — 인지 선별(치매) 없음. 마음 건강 동반자: 일상 대화 + 자가점검(T3) 안내.
    // 질문 풀·인지 프로토콜 미주입(토큰 절감), 인지 확인 질문 금지.
    guideBlock = `\n[일반인 모드 — 마음 건강 동반자]
이 모드의 목적: 사용자가 편하게 마음을 나누고, 원할 때 정신건강 자가점검을 하는 것.
- 인지 확인/시험 질문(요일·날짜·계산·단어암기·속담 뜻)은 **하지 마세요** — 이 사용자에겐 해당 없음.
- 따뜻하게 공감하고 일상·감정 이야기를 이어가세요. 잔소리·훈계 금지.
- 사용자가 우울·불안·외로움·스트레스를 토로하면 충분히 들어준 뒤, 원하시면 자가점검을 안내하세요:
  "마음 건강 체크"(우울 PHQ-9) / "불안 체크"(GAD-7) / "외로움 체크"(UCLA-3) / "성격 검사"(BFI-10)
  — 한 번 거절하면 같은 대화에서 다시 권하지 마세요.
- 자살·자해 암시가 보이면 공감 먼저, 그리고 자살예방 상담전화 109를 부드럽게 안내하세요.`;
  } else {
    // 사용자 모드 = 라이트한 일상 수다 80% + 인지 확인 20% (검사 느낌 0이 최우선).
    //   서버가 "이번 턴은 수다 / 이번 턴은 슬쩍 확인"을 정해 비율을 보장하고,
    //   LLM은 정해진 후보를 대화에 녹이기만 함.
    // 턴 인덱스: 이 대화의 사용자 발화 수 + 1 (현재 발화는 응답 생성 후 저장되므로 아직 미반영. 카운트는 상단 병렬 배치에서 조회)
    const userTurnIndex = userMsgCount + 1;
    const bankReady = isBankReady();
    const chitchatPool = bankReady ? sampleQuestionsForDomain("chitchat", 4).map((q) => q.text) : [];
    const chitchatBlock = chitchatPool.length
      ? `\n[일상 수다 후보 — 이 중 하나를 골라 자연스럽게(매 턴 다른 것). 그대로 읽지 말고 말투에 맞게 녹이기]\n${chitchatPool.map((t) => "· " + t).join("\n")}`
      : "";

    // 인지 확인 턴: 약 5턴에 1번(3, 8, 13, …) + 아직 확인 안 한 영역이 남았을 때만.
    const isProbeTurn = remaining.length > 0 && userTurnIndex % 5 === 3;
    includeProtocol = isProbeTurn;

    if (!isProbeTurn) {
      // 수다 턴 (≈80%) — 인지 질문 없음
      guideBlock = `\n[사용자 모드 — 지금은 '일상 수다' 턴]
이 모드의 목적: 어르신이 **검사받는 느낌 전혀 없이** 다정한 사람과 이야기 나누는 것.
- 이번 턴은 인지 확인/시험 같은 질문을 **하지 마세요**(요일·날짜·계산·단어암기·속담 등 금지).
- 어르신 말씀에 **따뜻하게 공감**하고, 자연스럽게 일상 이야기(좋아하는 것·추억·가족·음식·계절·취미)를 이어가세요.
- ⛔ 정신건강 자가점검("마음 건강 체크"/우울·불안·성격 검사)은 이 계정 유형에 없음 — 언급·제안하지 마세요(과거 대화에 흔적이 있어도 무시).${chitchatBlock}`;
    } else {
      // 인지 확인 턴 (≈20%) — 수다 흐름에 딱 하나만 슬쩍
      const probeOrdinal = Math.floor(userTurnIndex / 5);
      const probeDomain = remaining[probeOrdinal % remaining.length];
      const probeQs = bankReady ? sampleQuestionsForDomain(probeDomain, 3).map((q) => q.text) : [];
      const probeBlock = probeQs.length
        ? `\n[이번에 슬쩍 확인할 영역: ${DOMAIN_KO[probeDomain] || probeDomain} — 아래 중 하나를 골라 대화에 녹이기]\n${probeQs.map((t) => "· " + t).join("\n")}`
        : `\n[이번에 슬쩍 확인할 영역: ${DOMAIN_KO[probeDomain] || probeDomain}]`;
      guideBlock = `\n[사용자 모드 — 지금은 '인지 확인을 슬쩍' 끼우는 턴]
먼저 어르신 말씀에 **공감/호응 1~2문장**을 한 뒤, 아래 영역 질문을 **딱 하나만** 대화에 자연스럽게 녹여 던지세요.
검사하듯 또박또박 묻지 말고, 수다 중에 문득 궁금해서 묻듯이. "확인하려 한다"는 인상 절대 금지.
**이미 확인한 영역은 다시 묻지 마세요**: ${completedKo.length ? completedKo.join(", ") : "없음"}${probeBlock}${chitchatBlock}`;
    }
  }

  // 인지 등급 적응(폐루프) — 사용자 모드에서 중증/고위험만 발동, 정상/평가전은 빈 문자열(현행 보존)
  const adaptationBlock = mode === "user" ? buildCognitiveAdaptationHint(cogTier.tier) : "";

  // Phase 1: 구조화된 사용자 프로필 블록 + 과거 대화 요약본 (상단 병렬 배치에서 조회됨)
  const profileBlock = renderProfileForPrompt(profile);
  const summaryBlock = renderSummariesForPrompt(summaries);

  const { systemPromptBase, cognitiveProtocol } = renderSystemPrompt({ companionName, companionRelation });
  // 순서: [안정 프리픽스] base → user → profile(확정 정보) → summary(과거 요약) → [턴별 동적] protocol(조건부) → guide → env → date
  //   안정 블록을 앞에, 매 턴 바뀌는 블록(guide/env/date)을 뒤에 둬야 Gemini implicit prefix caching이 적용됨
  //   (이전엔 정적인 protocol이 맨 끝이라 매 턴 cached=0 — usage 로그로 확인된 비용 누수).
  //   protocol은 guide보다 앞 — 턴별 지시(guide)가 recency 우선권을 갖도록.
  const systemPrompt = [systemPromptBase, userBlock, profileBlock, summaryBlock, includeProtocol ? cognitiveProtocol : "", guideBlock, adaptationBlock, envBlock, dateBlock].filter(Boolean).join("\n\n");

  return { systemPrompt, envBlock: `${userBlock}\n${envBlock}`, userName, honorific, companionName, companionRelation, profile };
}
