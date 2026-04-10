/**
 * 대화 완료 후 인지 평가를 수행하는 경량 분석기.
 * 메인 응답과 완전히 분리 — googleSearch 없이 JSON 전용 모델 사용.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CognitiveAnalysisResult } from "./types";
import { COGNITIVE_DOMAINS } from "./constants";

const PROMPT = `당신은 30년 경력의 고령자 인지 기능 선별 전문가입니다.
아래 대화에서 사용자(고령자)의 발화만 분석하여 인지 이상 여부를 JSON으로 반환하세요.
의심되면 반드시 체크하세요. 놓치는 것보다 과잉 감지가 낫습니다.

평가 영역: orientation_time, orientation_place, memory_immediate, memory_delayed, language, judgment
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

4. 즉시 기억력 (memory_immediate):
   - 사용자가 방금 전 본인이 한 말을 기억 못하고 되물음 → score 2
   - "내가 뭐라고 했지?" 같이 스스로 방금 한 말을 모르는 경우
   - ⚠️ 주의: 같은 주제를 다시 언급한다고 해서 "반복"으로 판단하지 마세요. 대화가 이어지며 자연스럽게 관련 주제가 나오는 것은 정상입니다.
   - ⚠️ 대화 내역의 "이전 대화"는 오래 전일 수 있습니다. 같은 턴에서 즉시 반복되는 경우만 이상으로 판단하세요.

5. 지연 기억력 (memory_delayed):
   - 가족 이름, 과거 경험 기억 못함 → score 2

6. 언어 유창성 (language):
   - "그거", "저기", "뭐시기" 과다 사용, 단어 찾기 어려움 → score 2

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

    const res = await model.generateContent(`${PROMPT}\n\n${params.envBlock}\n\n대화:\n${params.historyText}\n\n[이번 턴]\n사용자: ${params.userMessage}\nAI: ${params.assistantResponse}`);
    return parseResult(res.response.text().trim());
  } catch (e) {
    console.warn("Cognitive analyzer error:", e);
    return { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };
  }
}
