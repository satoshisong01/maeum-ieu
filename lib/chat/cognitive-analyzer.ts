/**
 * 대화 완료 후 인지 평가를 수행하는 경량 분석기.
 * 메인 응답과 완전히 분리 — googleSearch 없이 JSON 전용 모델 사용.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CognitiveAnalysisResult } from "./types";
import { COGNITIVE_DOMAINS } from "./constants";

const PROMPT = `당신은 30년 경력의 고령자 인지 기능 선별 전문가입니다.
아래 대화에서 사용자(고령자)의 발화만 분석하여 인지 이상 여부를 JSON으로 반환하세요.

중요: AI가 인지 관련 질문을 했고 사용자가 답변했다면, 정상이더라도 반드시 해당 영역의 cognitiveCheck를 score 0으로 반환하세요.
예시: AI가 "오늘 무슨 요일이에요?" → 사용자가 "화요일이야" (정답) → {"domain": "orientation_time", "score": 0, "evidence": "화요일 정답", "note": "정상"}
이렇게 해야 같은 질문이 반복되지 않습니다. 정상 응답도 반드시 기록하세요.

평가 영역: orientation_time, orientation_place, memory_immediate, memory_delayed, language, judgment, attention_calculation
점수: 0(정상), 1(경계), 2(주의)

[필수 판단 기준 — 하나라도 해당되면 isAnomaly: true]

1. 시간 지남력 (orientation_time):
   - 날짜/월/년도/요일/계절을 틀리게 말함 → score 2
   - 예: "오늘 2003년이야", "지금 겨울이지?" (실제 4월)

2. 장소 지남력 (orientation_place):
   - 현재 위치와 다른 장소에 있다고 말함 → score 2
   - 환경 정보의 사용자 위치를 기준으로 판단하세요
   - 예: 동탄에 있는데 "나 지금 뉴욕에 있어", "여기 부산이잖아"

3. 판단력 (judgment):
   - 과거에 끝난 사건을 현재 일어나는 것처럼 말함 → score 2
   - 이미 사망한 인물을 만나겠다고 함 → score 2
   - 비현실적 경험 (외계인, 공룡 등) → score 2
   - 상황에 맞지 않는 행동 계획 (폭우에 반팔, 새벽 3시에 시장) → score 2
   - 예: "911테러가 방금 일어났어", "박정희 각하를 만나뵙기로 했어", "새마을운동 하러 가야지"

4. 즉시 기억력 (memory_immediate): ⛔ **매우 보수적으로 판단 — 기본값은 절대 체크 금지**
   - 이 영역을 이상(score 1 이상)으로 체크하려면 **세 조건 모두** 만족해야 함:
     (a) [이번 턴 사용자 발화]와 [최근 대화 맥락]의 직전 사용자 발화가 **글자 그대로 80% 이상 동일**
     (b) 그 사이에 AI의 응답이 한 번 있었고
     (c) 사용자가 그 AI 응답을 무시하고 동일 문장을 재생산함
   - ⛔ **"비슷한 주제"는 반복이 아닙니다**. "점심 먹었어" / "점심 맛있었어" → 반복 아님
   - ⛔ 주제 연속(허리 이야기 계속, 가족 이야기 계속)은 정상 대화이며 절대 반복 아님
   - ⛔ 사용자가 AI 질문에 답한 것은 반복 아님. 사용자가 새 정보 추가는 반복 아님
   - ⛔ 맥락에 이전 사용자 발화가 보인다고 "반복"이라 쓰지 마세요 — 그건 당연히 이전 대화일 뿐
   - ⛔ RAG/과거 대화와 비슷해도 반복 아님
   - ⚠️ **확실한 '앵무새 수준 완전 동일 문장' 아니면 절대 isAnomaly=true 만들지 마세요**
   - ⚠️ memory_immediate는 10,000턴 중 10턴 정도만 나오는 극히 드문 케이스입니다

5. 지연 기억력 (memory_delayed):
   - 가족 이름, 과거 경험 기억 못함 → score 2

6. 언어 유창성 (language):
   - "그거", "저기", "뭐시기" 과다 사용, 단어 찾기 어려움 → score 2

7. 주의력/계산 (attention_calculation):
   - AI가 **명시적으로 계산 문제**를 냈는데 사용자가 **틀린 숫자**로 답 → score 2
     예: AI "100-7은?" → 사용자 "85" (정답 93) → score 2
     예: AI "만원 내면 거스름돈은?" → 사용자 "3천원" (정답 다름) → score 2
   - AI가 숫자를 거꾸로 따라하라 했는데 실패 → score 2
   - **사용자 자발 발화에 수리적으로 불가능한 거래 묘사가 있으면 → score 2, isAnomaly=true**
     판정 절차: (1) 상품 가격 C, 지불 금액 P, 거스름돈 R을 모두 숫자로 추출 → (2) P-C=R 성립 여부 확인 → (3) 불성립이면 이상
     예: "만원짜리 책 샀는데 거스름돈 2만원 받았어" → C=10000, P=?, R=20000. 어떤 P도 P-C=R 불가(P=30000 필요, 그러나 "만원짜리 책 샀는데 3만원 냈다"는 언급 없음) → score 2
     예: "나물 5천원어치 사고 천원 냈는데 4천원 받아왔어" → C=5000, P=1000, R=4000. P<C인데 R이 양수 → 불가능 → score 2
     예: "만원 내고 3천원 짜리 빵 사서 7천원 거스름 받았어" → 10000-3000=7000 → 정상
   - 과거 회상형("예전에~", "옛날에 장사할 때~")은 단순 추억일 수 있으므로 제외
   - ⛔ **"주제 이탈"이나 "딴 소리"만으로는 절대 판단하지 마세요**. 아래 금지 예시 확인:
     ❌ 오탐 금지: AI "뭘 입으실 거예요?" → 사용자 "분리수거 했어" → 주제 전환일 뿐 **정상**
     ❌ 오탐 금지: AI "지갑을 주우면?" → 사용자 "이발소 다녀왔어" → 단순 주제 변경 **정상**
     ❌ 오탐 금지: AI "고양이 키우신 지 얼마나?" → 사용자 "강아지 산책시켰어" → 주제 전환 **정상**
   - 사용자가 AI 질문에 답하지 않고 새 주제를 꺼내는 것은 **일상 대화 패턴**입니다. 인지 이상 아닙니다.
   - 실제 계산 오류/숫자 실패가 없으면 이 영역은 체크하지 마세요.

[예외 — isAnomaly: false로 판단해야 하는 경우]
- 사용자가 AI의 오류를 정정하는 경우 (AI가 틀렸을 수 있음)
- 과거 회상을 명확히 "옛날에~", "그때는~"으로 시작하는 경우
- 사용자가 상대방(AI)에게 되묻거나 확인하는 경우 ("저번에 말하지 않았나", "아까 얘기했잖아") — 이는 기억력 문제가 아니라 대화 흐름상 자연스러운 되물음
- 사용자가 AI에게 질문하는 행위 자체 — 질문한다고 기억력 문제가 아님
- 사용자가 AI의 기능/능력을 테스트하는 질문 (예: "내 이름이 뭐지?", "내 위치가 어디게?", "오늘 며칠이게?", "내가 누구야?") — 이는 AI에게 물어보는 것이지 본인이 잊은 것이 아님. 절대 memory/orientation 이상으로 판단하지 마세요
- 사용자가 AI를 떠보거나 시험하는 말투 ("니가 알아?", "맞춰봐", "~게?") — 평가 대상 아님
- 농담, 장난, 비꼼 — 액면 그대로 받아들이지 마세요
- 근거가 불충분하거나 애매한 경우 — 확실한 근거 없이 추측하지 마세요
- 2문장 이하의 짧은 발화로는 이상 판단을 신중하게 — 1턴만 보고 성급히 판단하지 말 것
- ⚠️ AI가 한 턴에 여러 질문을 했을 때 사용자가 그 중 하나에만 답한 경우 → 정상입니다. "새 질문에 응답 안 함"이 아니라 "이전 질문에 답한 것"입니다
- ⚠️ 사용자가 AI의 직전 질문에 대해 답변한 것이면 무조건 정상. 예: AI "산책 중이세요?" → 사용자 "산책중이라고 할수있지" → 이건 정상 답변입니다
- ⚠️ 사용자의 답변이 AI의 최근 2턴 내 질문 중 하나와 관련 있으면 "반복"이나 "딴 소리"로 판단하지 마세요

JSON 형식:
{"isAnomaly": false, "analysisNote": "", "cognitiveChecks": []}
cognitiveChecks 항목: {"domain": "영역", "score": 0, "confidence": 0.8, "evidence": "근거", "note": "사유"}
`;

function parseResult(raw: string): CognitiveAnalysisResult {
  const empty: CognitiveAnalysisResult = { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return empty;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;

    const result: CognitiveAnalysisResult = {
      isAnomaly: parsed.isAnomaly === true,
      analysisNote: typeof parsed.analysisNote === "string" ? parsed.analysisNote.slice(0, 500) : "",
      cognitiveChecks: [],
    };

    if (Array.isArray(parsed.cognitiveChecks)) {
      const valid = new Set<string>(COGNITIVE_DOMAINS);
      result.cognitiveChecks = (parsed.cognitiveChecks as Record<string, unknown>[])
        .filter((c) => typeof c.domain === "string" && valid.has(c.domain) && typeof c.score === "number")
        .map((c) => ({
          domain: c.domain as string,
          score: Math.min(2, Math.max(0, c.score as number)),
          confidence: typeof c.confidence === "number" ? Math.min(1, Math.max(0, c.confidence)) : 0.5,
          evidence: typeof c.evidence === "string" ? (c.evidence as string).slice(0, 500) : "",
          note: typeof c.note === "string" ? (c.note as string).slice(0, 500) : "",
        }));
    }
    return result;
  } catch {
    return empty;
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]/gu, "");
}

function similarity(a: string, b: string): number {
  const A = normalize(a);
  const B = normalize(b);
  if (!A.length || !B.length) return 0;
  const shorter = A.length < B.length ? A : B;
  const longer = A.length < B.length ? B : A;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  let common = 0;
  for (let i = 0; i < shorter.length - 2; i++) {
    if (longer.includes(shorter.slice(i, i + 3))) common += 1;
  }
  return Math.min(1, common / Math.max(1, shorter.length - 2));
}

function extractPrevUserMessage(historyText: string): string {
  const lines = historyText.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/^\s*(?:사용자|user|User|USER)\s*[:：]\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

function validateMemoryImmediate(
  result: CognitiveAnalysisResult,
  userMessage: string,
  historyText: string,
): CognitiveAnalysisResult {
  const memCheck = result.cognitiveChecks.find((c) => c.domain === "memory_immediate");
  if (!memCheck || memCheck.score === 0) return result;

  const prevUser = extractPrevUserMessage(historyText);
  const sim = similarity(userMessage, prevUser);

  if (sim < 0.8) {
    const filtered = result.cognitiveChecks.filter((c) => c.domain !== "memory_immediate");
    const otherAnomaly = filtered.some((c) => c.score >= 2);
    const isAnomaly = result.isAnomaly && otherAnomaly;
    let analysisNote = result.analysisNote;
    if (/반복|직전|같은 문장|즉시 기억/.test(analysisNote)) {
      analysisNote = otherAnomaly ? analysisNote.replace(/(반복|직전).*$/, "").trim() : "";
    }
    return { ...result, isAnomaly, analysisNote, cognitiveChecks: filtered };
  }
  return result;
}

export async function analyzeCognitive(params: {
  userMessage: string;
  assistantResponse: string;
  historyText: string;
  envBlock: string;
}): Promise<CognitiveAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };

  try {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: "application/json" },
    });

    const historyLines = params.historyText.split("\n");
    const recentHistory = historyLines.slice(-10).join("\n");

    const res = await model.generateContent(`${PROMPT}\n\n${params.envBlock}\n\n최근 대화 맥락:\n${recentHistory}\n\n[이번 턴 — 이것만 분석하세요]\n사용자: ${params.userMessage}\nAI: ${params.assistantResponse}`);
    const raw = parseResult(res.response.text().trim());
    return validateMemoryImmediate(raw, params.userMessage, recentHistory);
  } catch (e) {
    console.warn("Cognitive analyzer error:", e);
    return { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };
  }
}
