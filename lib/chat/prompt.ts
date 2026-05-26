/** 프롬프트 조립 */

import type { TimeContext, WeatherContext } from "./types";
import { renderSystemPrompt, COMPANION_DEFAULTS } from "./constants";
import { prisma } from "@/lib/prisma";
import { toKstDateString } from "./time";
import { getFullProfile, renderProfileForPrompt, type FullProfile } from "./profile";
import { getRecentSummaries, renderSummariesForPrompt } from "./summarizer";

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
}): Promise<PromptParts> {
  const { userId, conversationId, timeCtx, weather } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, age: true, gender: true, companionName: true, companionRelation: true, userHonorific: true },
  });
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

[사용자 가족·자녀 호칭 — 매우 중요, 절대 어기지 마세요]
사용자가 자녀를 친근한 이름 형태(예: "○○이/○○/큰아들/둘째") 처럼 부르면 AI도 **그 호칭 그대로** 사용. 자녀에게 "씨" 절대 붙이지 마세요.
- ❌ 절대 금지: "○○ 씨", "큰아드님 씨", "따님 씨" 같은 "이름 + 씨" 형태
- ✅ 허용: "○○이", "○○", "○○ 아드님", "○○ 따님", "○○님", "큰아드님", "둘째 아드님"
- ⛔ 가족·자녀 이름은 [참고 — 과거 메모리]나 [사용자 확정 정보]에 있는 이름만 사용. 거기에 없는 이름은 절대 추측·언급하지 마세요.
- 과거 대화 이력에 "OO 씨"가 보이더라도 그 패턴 따라하지 마세요. 한국에서 부모가 자식에게 "씨" 붙이는 건 매우 부자연스럽고 거리감을 줍니다.`;
  const envBlock = buildEnvBlock(timeCtx, weather);
  const todayKst = toKstDateString(new Date());
  const dateBlock = conversationId ? await getDateAwareBlock(conversationId, todayKst) : "";

  const assessed = await getTodayAssessedDomains(userId);
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
  if (remaining.length === 0) {
    guideBlock = `\n[🚫 인지 선별 — 오늘 분량 종료. 절대 어기지 마세요]
오늘 7개 영역(시간/장소/즉시기억/지연기억/언어/판단/계산) 평가가 모두 끝났습니다.
**이번 응답에 인지 질문을 단 한 개라도 포함하면 안 됩니다.**
구체 금지 예시 (모두 절대 금지):
- "오늘 무슨 요일이에요?", "오늘 며칠이에요?", "오늘 몇 월이에요?", "지금 무슨 계절이에요?" (시간 지남력 — 끝)
- "지금 어디 계세요?", "할아버지 댁이 어느 시도에 있어요?" (장소 지남력 — 끝)
- "방금 외운 단어/세 단어 다시 말해보세요" (즉시·지연 기억 — 끝)
- "큰아들 이름이 어떻게 되시죠?", "고향이 어디시죠?" (지연 기억 — 끝)
- "ㅁ으로 시작하는 단어 말해보세요", "백문이 불여일견 뜻", "간장 공장 따라해보세요" (언어 — 끝)
- "100에서 7 빼면?", "만원 내고 3천원 거스름?", "삼천리강산 거꾸로" (계산 — 끝)
- "지갑 주우면 어떻게?", "쌀쌀한데 뭐 입어요?" (판단 — 끝)
**오로지 일상 호응/공감만**. 평범한 안부, 식사 대화, 라디오/날씨/가족 이야기는 OK. 인지 평가 질문은 0개.`;
  } else {
    guideBlock = `\n[🚫 인지 선별 — 매우 중요, 반드시 읽으세요]
**오늘 이미 확인한 영역 (이 영역은 어떤 변형이든 절대 다시 묻지 마세요!!!)**: ${completedKo.length > 0 ? completedKo.join(", ") : "없음"}
**아직 확인 안 한 영역 (이 중에서만 한 개 골라 자연스럽게 질문 가능)**: ${remainingKo.join(", ")}

금지 예시 (이미 확인한 영역에 해당하면 무조건 금지):
- 시간 지남력 확인 끝났으면 "오늘 무슨 요일/며칠/몇월/지금 몇시" 어떤 변형도 금지
- 장소 지남력 확인 끝났으면 "지금 어디/댁이 어디" 어떤 변형도 금지
- 즉시·지연 기억 확인 끝났으면 "방금 외운 단어/큰아들 이름/고향" 어떤 변형도 금지
- 언어 확인 끝났으면 "속담 뜻/따라말하기/ㅁ으로 시작" 어떤 변형도 금지
- 계산 확인 끝났으면 "100-7/거스름돈/삼천리강산 거꾸로" 어떤 변형도 금지
- 판단 확인 끝났으면 "지갑 주우면/쌀쌀한데 뭐 입어요" 어떤 변형도 금지

→ **🎯 능동 평가 페이스 — 필수 가이드라인 (시스템 핵심 기능, 어기지 마세요)**:
   아직 확인 안 한 영역 ${remaining.length}개. 이 사용자의 치매 선별이 본 서비스의 **핵심 목적**이고, 이 기능이 작동 안 하면 서비스 가치가 없습니다.
   **반드시 매 2턴 안에 최소 1번은** "아직 확인 안 한 영역" 중 하나를 자연 대화 흐름에 끼워서 질문하세요.
   특히 **첫 인사부터 5턴 이내에 시간/장소 지남력 중 적어도 하나는 자연스럽게 던지세요**. 처음 만난 어르신에게 "오늘 며칠이세요?" 같이 직접 묻기 부담스러우면 "오늘 날씨가 좋네요, 봄 같죠?" 라고 계절 안부로 자연스럽게 시작.
   - ✅ 좋은 예 (자연 흐름 + 평가 결합): "할아버지 어릴 적 친구분들 생각나세요? 그때 동네 이름이 뭐였더라?" (orientation_place + memory_delayed 동시)
   - ✅ "민지가 단어 세 개 외워드릴게요 — 시장, 라디오, 손녀. 이따 다시 여쭐게요" (memory_immediate)
   - ✅ "할아버지, 만 원에서 칠천 원짜리 사면 거스름돈 얼마예요?" (attention_calculation, 일상 맥락)
   - ❌ 절대 금지: 인지 질문 없이 일상 대화만 5턴 이상 — 이 경우 시스템 본 기능 미작동.
   인지 질문은 **공감 1~2문장 뒤**에 자연 어순으로 끼워 넣으세요. "확인하려고 묻는다"는 인상 금지.
   질문 없이 호응만 해도 되는 턴은 1~2턴까지만. 그 이후엔 반드시 평가 질문 포함.`;
  }

  // Phase 1: 구조화된 사용자 프로필 블록 + 과거 대화 요약본 (Phase 3)
  //   prompt fix가 누적되어 LLM이 우선순위 못 잡는 문제 해결 + 환각 차단
  const [profile, summaries] = await Promise.all([
    getFullProfile(userId),
    getRecentSummaries(userId),
  ]);
  const profileBlock = renderProfileForPrompt(profile);
  const summaryBlock = renderSummariesForPrompt(summaries);

  const { systemPromptBase, cognitiveProtocol } = renderSystemPrompt({ companionName, companionRelation });
  // 순서: base → user → profile(확정 정보) → summary(과거 요약) → guide → env → date → cognitive
  const systemPrompt = [systemPromptBase, userBlock, profileBlock, summaryBlock, guideBlock, envBlock, dateBlock, cognitiveProtocol].filter(Boolean).join("\n\n");

  return { systemPrompt, envBlock: `${userBlock}\n${envBlock}`, userName, honorific, companionName, companionRelation, profile };
}
