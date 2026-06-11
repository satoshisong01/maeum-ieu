/**
 * T3 응답 분류기 — 자연어 답변을 PHQ-9 빈도 점수(0~3)로 분류.
 * 1차: 정규식 fast-path (명확한 표현 — LLM 비용 0)
 * 2차: 경량 LLM(2.5-flash, responseSchema) — 모호한 답변만
 * -1 = 분류 불가(재질문 필요). 응답 원문은 어디에도 저장하지 않음.
 */
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { COMPANION_SAFETY_SETTINGS, logUsage } from "@/lib/chat/llm";

// 순서 중요 — 강한 빈도(3)부터 검사 (예: "거의 매일"이 "며칠"보다 먼저)
const FAST_PATTERNS: Array<{ score: 0 | 1 | 2 | 3; pattern: RegExp }> = [
  { score: 3, pattern: /거의\s*매일|매일\s*(?:같이|그래|그랬|이야|이었)|맨날|밤낮없이|하루도\s*안?\s*빠짐|항상\s*그(?:래|랬)/ },
  { score: 2, pattern: /절반.{0,3}(?:이상|넘|쯤)|반\s*(?:은\s*)?(?:이상|넘)|일주일에\s*[4-7]|자주\s*그(?:래|랬)|꽤\s*많(?:이|은)/ },
  { score: 1, pattern: /며칠|몇\s*[일번]|가끔|종종|한두\s*[번일]|두세\s*[번일]|일주일에\s*[1-3]|드물게|조금\s*있/ },
  { score: 0, pattern: /전혀|하나도\s*없|없었|없어|아니(?:요|야|에요)?\s*[.!~]?$|안\s*그(?:래|랬)|그런\s*적\s*없|괜찮(?:아|았)/ },
];

export function classifyFast(answer: string): number {
  const t = answer.trim();
  if (!t) return -1;
  for (const { score, pattern } of FAST_PATTERNS) {
    if (pattern.test(t)) return score;
  }
  return -1;
}

const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: { score: { type: SchemaType.INTEGER } },
  required: ["score"],
};

const CLASSIFY_PROMPT = `다음은 "지난 2주 동안 얼마나 자주 그랬는지" 묻는 설문에 대한 한국어 답변입니다.
답변을 빈도 점수로 분류하세요:
0 = 전혀 없었다 / 1 = 며칠 정도 / 2 = 2주의 절반 이상 / 3 = 거의 매일
답변이 빈도와 무관하거나(딴 얘기, 질문) 판단이 정말 불가능하면 -1.
주의: 부정("안 그래", "없어")은 0. 약한 긍정("좀 그랬어", "가끔")은 1. 강한 긍정("계속", "내내")은 3.
JSON {"score": n} 만 출력.`;

export async function classifyFrequencyAnswer(answer: string): Promise<number> {
  const fast = classifyFast(answer);
  if (fast >= 0) return fast;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return -1;
  try {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: "gemini-2.5-flash",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generationConfig: { temperature: 0, maxOutputTokens: 64, responseMimeType: "application/json", responseSchema: SCHEMA, thinkingConfig: { thinkingBudget: 64 } } as any,
      safetySettings: COMPANION_SAFETY_SETTINGS,
    });
    const res = await model.generateContent(`${CLASSIFY_PROMPT}\n\n답변: ${answer.slice(0, 200)}`);
    logUsage("mental-classify", res);
    const parsed = JSON.parse(res.response.text().trim()) as { score?: number };
    const s = typeof parsed.score === "number" ? Math.round(parsed.score) : -1;
    return s >= 0 && s <= 3 ? s : -1;
  } catch (e) {
    console.warn("[mental-scorer] classify error:", (e as Error).message);
    return -1;
  }
}
