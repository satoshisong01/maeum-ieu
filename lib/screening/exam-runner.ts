/**
 * 전문가 검진 상태머신 러너 — 영역별 표준 문항을 순서대로 시행하고, 답변을 항목별 0~배점으로 채점.
 * 진행은 영역 단위(한 번에 한 영역 배터리 질문), 채점은 항목 단위(정식 점수). 음성 미시행(시공간) 제외.
 */
import { CIST_ITEMS, buildExamOrder, CIST_DOMAIN_ORDER, VOICE_MAX_POINTS, type CistItem } from "./cist-bank";
import { getGenAI, COMPANION_SAFETY_SETTINGS, logUsage } from "@/lib/chat/llm";
import { Type as SchemaType, type Schema } from "@google/genai";

const SCORER_MODEL = "gemini-2.5-flash";

export { VOICE_MAX_POINTS };

/** 검진 영역 시행 순서(시드로 매 검진 변형, 타당성 제약 유지). */
export function buildExamPlan(seed: string): string[] {
  return buildExamOrder(seed);
}

export function domainLabel(domain: string): string {
  return CIST_DOMAIN_ORDER.find((d) => d.domain === domain)?.label ?? domain;
}

export function itemsForDomain(domain: string): CistItem[] {
  return CIST_ITEMS.filter((i) => i.domain === domain && i.voice);
}

/** 한 영역의 문항(들)을 검사자가 읽을 한 번의 질문으로 렌더. */
export function renderDomainBattery(domain: string): string {
  return itemsForDomain(domain).map((i) => i.prompt).join(" ");
}

/** 영역 배점 합(만점). */
export function domainMaxPoints(domain: string): number {
  return itemsForDomain(domain).reduce((s, i) => s + i.points, 0);
}

// 무응답 영역 재질문용 — 더 쉽고 부드러운 대체 표현(예비문항). 같은 영역을 다시 묻되 표현을 낮춤.
const DOMAIN_REASK: Record<string, string> = {
  orientation_time: "천천히 생각하셔도 괜찮아요. 올해가 몇 년도일까요? 지금은 무슨 계절인가요?",
  orientation_place: "지금 계신 여기가 어디인지 편하게 말씀해 주세요. 무슨 동네, 어떤 곳인가요?",
  memory_immediate: "제가 단어 세 개를 천천히 다시 불러드릴게요 — ‘나무, 자동차, 모자’. 따라서 말씀해 보세요.",
  attention_calculation: "괜찮아요, 천천히 하셔도 돼요. 100에서 7을 빼고, 거기서 또 7씩 빼 나가 보실까요? (93, 86 …처럼요)",
  memory_delayed: "조금 전에 외워 두시라고 한 단어가 있었죠. 하나라도 생각나는 게 있으면 말씀해 주세요.",
  language: "제가 짧은 문장을 천천히 말할게요 — ‘백문이 불여일견’. 그대로 따라 해 보세요.",
  judgment: "기차하고 자전거, 둘 다 어디에 쓰는 물건일까요? 편하게 떠오르는 대로 말씀해 주세요.",
};

/** 응답이 사실상 없음(빈 응답·부호만·거부) — 무응답 처리/재질문 트리거. '모르겠다'는 응답으로 간주(=시도, 0점). */
export function isNonResponse(answer: string): boolean {
  const a = (answer || "").trim();
  const stripped = a.replace(/[\s.,…·~!?\-‘’"']/g, "");
  if (stripped.length === 0) return true; // 빈 응답 또는 "..." 같은 부호만
  if (/^(그만|안\s*할|안\s*해|안\s*하|싫|패스|관둬|관둘|됐어|됐다|하기\s*싫|그만하)/.test(a)) return true; // 명시적 거부
  return false;
}

/** 무응답 영역 재질문 — 더 쉬운 표현(없으면 원 문항). */
export function renderDomainReask(domain: string): string {
  return DOMAIN_REASK[domain] || renderDomainBattery(domain);
}

const SCORE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    scores: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          itemId: { type: SchemaType.STRING },
          score: { type: SchemaType.INTEGER },
          reason: { type: SchemaType.STRING },
        },
        required: ["itemId", "score"],
      },
    },
  },
  required: ["scores"],
};

export interface ItemScore { itemId: string; domain: string; label: string; prompt: string; answer: string; score: number; max: number; reason: string }

/**
 * 한 영역 답변을 항목별로 채점(0~배점). 무응답·거부·딴소리는 0점. 채점 실패 시 0점 처리.
 * env: 오늘 날짜/계절/요일 등 환경(시간 지남력 채점에 필수 — 없으면 연도·요일 정답 판정 불가).
 * 장소 지남력은 환자 실제 위치를 시스템이 모르므로 "검사자 확인 필요"로 보수 채점(구체·일관 답변만 인정).
 */
export async function scoreDomainAnswer(domain: string, answer: string, env?: string): Promise<ItemScore[]> {
  const items = itemsForDomain(domain);
  const base = (score: number, reason: string): ItemScore[] =>
    items.map((i) => ({ itemId: i.id, domain, label: domainLabel(domain), prompt: i.prompt, answer, score, max: i.points, reason }));

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !answer.trim()) return base(0, !answer.trim() ? "무응답" : "채점 불가");

  const envBlock = env ? `\n[채점 기준 환경 — 정답 판정에 사용]\n${env}\n` : "";
  const placeNote = domain === "orientation_place"
    ? "\n⚠ 장소 지남력: 시스템은 환자의 실제 위치를 모릅니다. 답변이 구체적이고 일관된 한국 지명·장소면 정답으로 인정(검사자가 최종 확인). '모르겠다'·무응답·비현실적이면 0점.\n"
    : "";
  const itemSpec = items.map((i) => `- ${i.id} (배점 ${i.points}): 문항 "${i.prompt}" / 채점기준: ${i.scoring}`).join("\n");
  const prompt = `당신은 표준 인지선별검사(MMSE-K/MoCA-K/CIST) 채점자입니다. 아래 문항들에 대한 환자 답변을 각 채점기준대로 채점하세요.
- 무응답·거부·딴 얘기·"모르겠다"는 0점.
- 각 항목 점수는 0 이상 배점 이하 정수. 부분정답은 채점기준대로.
- 답변에 여러 문항이 섞여 있으면 각 문항에 해당하는 부분만 보고 채점.
- 시간 지남력(연도·계절·월·일·요일)은 위 환경의 오늘 날짜와 대조해 정답 판정.${envBlock}${placeNote}
[문항]
${itemSpec}

[환자 답변]
"${answer.slice(0, 600)}"

JSON으로만: {"scores":[{"itemId":"...","score":N,"reason":"간단근거"}]}`;

  try {
    const res = await getGenAI().models.generateContent({
      model: SCORER_MODEL,
      contents: prompt,
      config: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json", responseSchema: SCORE_SCHEMA, thinkingConfig: { thinkingBudget: 512 }, safetySettings: COMPANION_SAFETY_SETTINGS },
    });
    logUsage("exam-scorer", res);
    const parsed = JSON.parse((res.text ?? "{}").trim()) as { scores?: { itemId: string; score: number; reason?: string }[] };
    const map = new Map((parsed.scores ?? []).map((s) => [s.itemId, s]));
    return items.map((i) => {
      const s = map.get(i.id);
      const score = s ? Math.max(0, Math.min(i.points, Math.round(Number(s.score) || 0))) : 0;
      return { itemId: i.id, domain, label: domainLabel(domain), prompt: i.prompt, answer, score, max: i.points, reason: s?.reason ?? "" };
    });
  } catch {
    return base(0, "채점 오류");
  }
}
