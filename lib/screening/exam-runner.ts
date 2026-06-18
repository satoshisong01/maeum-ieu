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
