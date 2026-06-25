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
// 광범위 "우려 신호" 사전 — 정규식 none일 때 백스톱 LLM을 부를지 결정. 좁으면 백스톱이 의도를 보기도 전에 skip되어
//   진짜 응급을 놓침(2026-06-25 라운드1: 목매·따라가·곁으로·안깨어나·화상·입에넣 누락). 우려 가능성 있으면 일단 부르고 판정은 LLM이.
//   순수 일상(날씨·밥·가족·취미·인사)은 여기 안 걸려 skip → 비용 억제.
export const SOFT_SIGNAL = /약|수면제|죽|자살|목(?:이라도|을|에)?\s*[매졸]|매달|올가미|끈\s|뛰어내|투신|번개탄|연탄|목숨|세상\s*[뜨떠]|저\s*세상|먼저\s*[가갈]|따라\s*[가갈]|곁으로|조용히\s*[가갈]|가\s*[뿌뿔삐]|살\s*맛|폐[\s가-힣]{0,4}끼|짐\s*(?:만|이|덩)|그만\s*살|살기\s*(?:가|를)?\s*싫|사라지|없어졌으면|없어지고|눈\s*감|눈\s*안\s*[뜨떠떴]|안\s*깨|깨어나|영원|편하게\s*[가갈]|편히\s*[가갈]|(?:죽는|가는|편한)\s*방법|모[아았]|털어|들이[켜키]|삼[키켜켰]|먹어버|먹어불|입에\s*[넣털]|두\s*번|두\s*알|세\s*알|한\s*알|또\s*먹|섞어|헷갈|착각|움큼|한\s*통|숨|가슴|쓰러|넘어|미끄러|자빠|나자빠|삐끗|엎어|고꾸라|못\s*일어|일어나지\s*(?:를\s*)?못|일어날\s*수\s*없|허리를?\s*못\s*[쓰써]|피[가\s]|출혈|어지|핑\s*도|식은\s*땀|손\s*(?:이|을)?\s*떨|떨려|떨린|마비|경련|발작|의식|안\s*올라가|헛나|어눌|혀\s*꼬|부들부들|벌벌\s*떨|덜덜\s*떨|거품\s*물|까무러|까무라|기절|혼절|삐[뚤뚜]|비뚤|감각\s*(?:이|도)?\s*(?:없|둔)|(?:한|왼|오른|반)\s*[쪽짝편]\s*(?:팔|다리|손|발|몸|얼굴|눈|입)|반신\s*마|기운\s*(?:이|을)?\s*(?:없|빠)|기력|당뇨|혈압|토[하해]|구역|메스|데[였여어]|화상|끓는|뜨거운\s*물|물집|살갗|부러|골절|삐[었어]|쥐\s*나|저[려린릿]|열이\s*(?:나|많|펄)|힘들|외로|혼자|괴로|우울|허전|보고\s*싶|그립|눈물/;

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
판정 원칙: 확실치 않으면 보수적으로 — 진짜 위기를 놓치는 것보다 약하게라도 잡는 게 낫습니다. 단, 단순 복약 질문·부정문·평범한 일상, 그리고 "보고 싶어 죽겠다 / 좋아 죽겠다 / 배고파 죽겠다 / 보고 싶어 죽겠어"처럼 그리움·강조의 관용 표현(실제 자살 의도 아님)은 반드시 none(과잉경보 금지). 먼저 떠난 가족을 그리워하고 보고 싶어하는 것은 애도이지 자살이 아니다(none) — 그 사람을 "따라가겠다/곁으로 가겠다"는 실제 의도가 명시될 때만 suicidal. 자살은 스스로 목숨을 끊으려는 실제 의도가 있을 때만. 또한 "잠깐/가끔/조금/천천히 하면 괜찮은" 정도의 경미하고 일시적인 신체 증상은 none — medical_acute는 갑작스럽고 심하거나 지속되는 경우만(예: "휙 일어나면 잠깐 핑 도는 정도"·"가끔 무릎이 쑤셔"는 응급 아님). 이미 지나가고 해소된 과거 사건("예전에 약을 잘못 먹은 적 있었지, 그 뒤로는 잘 챙겨")은 현재 위기가 아니므로 none.

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
