/**
 * 응급 LLM 백스톱 — 정규식(detectEmergency)이 놓친 과소감지 꼬리를 의미 기반으로 포착.
 *
 * 원칙:
 * - 정규식이 level 0(none)일 때만 호출되는 "안전 그물"(정규식 대체 아님).
 * - 사전필터(SOFT_SIGNAL)로 신호 의심 발화에서만 LLM 호출 → 평범한 대화는 비용·지연 0.
 * - 장애/미설정/판정불가 시 null 반환 → 정규식만으로 동작(기존과 동일, 더 나빠지지 않음).
 *
 * 배경: 라이브 사이클 + 적대적 검증에서 사투리·완곡어·어순 변형의 자살/과다복용 신호가
 *       정규식·moderation 양쪽을 빠져나가던 과소감지 발견(2026-06-25). 정규식 보강 + 본 백스톱 병행.
 */
import { getGenAI, COMPANION_SAFETY_SETTINGS, logUsage } from "@/lib/chat/llm";
import { Type as SchemaType, type Schema } from "@google/genai";
import type { EmergencyResult, EmergencyCategory } from "@/lib/chat/emergency";

const MODEL = "gemini-2.5-flash";

// 소프트 신호 사전필터 — 이 중 하나라도 없으면 LLM 호출 자체를 skip(대부분의 일상 대화는 여기서 걸러짐).
//   넓게 잡아 과소감지를 막되, "오늘 날씨 좋네" 같은 무신호 발화는 통과시켜 비용을 억제.
const SOFT_SIGNAL = /약|수면제|죽|자살|숨|가슴|쓰러|넘어|미끄러|피[가\s]|어지|힘들|외로|혼자|그만|살기|사라지|따라가|잠들|못\s*깨|깨어나|영원|먼저\s*[가갈]|확\s*[가갈]|모아|털어|들이[켜키]|삼[키켜켰]|먹어버|먹어불|두\s*번|두\s*알|또\s*먹|섞어|헷갈|착각|움큼|한\s*통/;

const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    category: { type: SchemaType.STRING },
    level: { type: SchemaType.INTEGER },
    reason: { type: SchemaType.STRING },
  },
  required: ["category", "level"],
};

const VALID = new Set<EmergencyCategory>([
  "suicidal", "medical_acute", "medication_error", "fall_injury", "bleeding",
]);

/**
 * 발화가 응급/위기 신호인지 LLM으로 판정. 정규식이 none일 때의 백스톱.
 * @returns 위기로 판정되면 EmergencyResult(level≥2), 아니면 null.
 */
export async function detectEmergencyLLM(userText: string): Promise<EmergencyResult | null> {
  const text = (userText || "").trim();
  if (!text || text.length > 1000) return null;
  if (!SOFT_SIGNAL.test(text)) return null;          // 신호 없음 → LLM 호출 안 함
  if (!process.env.GEMINI_API_KEY) return null;      // 키 없음 → 정규식만으로

  const prompt = `당신은 노인 돌봄 대화의 안전 분류기입니다. 아래 한 발화가 응급/위기 신호인지 판정하세요. 한국어 사투리·완곡어·우회표현까지 의도 중심으로 해석합니다.

[카테고리]
- suicidal: 자살·자해 의도. 과량복용으로 죽거나 영원히 잠들려는 것, 먼저 떠난 사람 곁으로 가려는 것, 죽으려고 약을 모아두는 것 등 완곡·우회 표현 포함.
- medical_acute: 의식저하·호흡곤란·뇌졸중(한쪽 마비·말 어눌)·급성 심장 증상 등.
- medication_error: 실수로 약을 중복/과다 복용한 "완료된 사고". ※복용 여부를 묻는 질문이나 "잘못 먹은 게 아니다" 같은 부정문은 none.
- fall_injury: 낙상·부상으로 못 일어남. bleeding: 멈추지 않는 출혈.
- none: 위 어디에도 아님(평범한 일상·단순 질문·정상 복약 포함).

[레벨] 3=즉시 위기, 2=주의, 0=응급 아님.
판정 원칙: 확실치 않으면 보수적으로 — 진짜 위기를 놓치는 것보다 약하게라도 잡는 게 낫습니다. 단, 단순 복약 질문·부정문·평범한 일상은 반드시 none(과잉경보 금지).

[발화]
"${text.slice(0, 600)}"

JSON으로만: {"category":"...","level":N,"reason":"간단근거"}`;

  try {
    const res = await getGenAI().models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        // ⚠ maxOutputTokens는 thinking + 출력 합산 — thinkingBudget(256)보다 충분히 커야 JSON이 안 잘림
        //   (thinkingBudget 256 + maxOutputTokens 256이면 thinking이 예산을 다 먹어 출력이 잘려 파싱 실패)
        temperature: 0,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        thinkingConfig: { thinkingBudget: 256 },
        safetySettings: COMPANION_SAFETY_SETTINGS,
      },
    });
    logUsage("emergency-llm", res);
    const parsed = JSON.parse((res.text ?? "{}").trim()) as { category?: string; level?: number };
    const category = parsed.category as EmergencyCategory;
    const level = Math.max(0, Math.min(3, Math.round(Number(parsed.level) || 0)));
    if (!VALID.has(category) || level < 2) return null; // none/저신뢰는 백스톱 발동 안 함(L2 이상만)
    return { level: level as 2 | 3, category, evidence: `llm:${text.slice(0, 40)}` };
  } catch {
    return null; // 장애 시 정규식만으로(기존 동작)
  }
}
