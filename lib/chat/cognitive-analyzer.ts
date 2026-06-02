/**
 * 대화 완료 후 인지 평가를 수행하는 경량 분석기.
 * 메인 응답과 완전히 분리 — googleSearch 없이 JSON 전용 모델 사용.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CognitiveAnalysisResult } from "./types";
import { COGNITIVE_DOMAINS } from "./constants";
import { normalizeDialect } from "./dialect-normalize";

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
   - ⚠️ **근소한 날짜 오차는 이상 아님(score 0)**: 실제 날짜와 **며칠(약 1주) 이내** 차이, 또는 **월말↔월초·계절 경계** 수준의 작은 어긋남은 정상으로 보세요. 예: 실제 6월 1일인데 "5월 말이지"(3일 차이), 실제 3월 1일인데 "아직 겨울 끝물이지" → **score 0**. score 2(주의)는 **연도·계절이 명백히 틀리거나 여러 달/년 어긋난 경우**에만. (노인 화법상 날짜를 대략 말하는 건 정상)
   - ⚠️ 직전 AI 발화가 잘못된 날짜를 제시했고 사용자가 그걸 따라 말한 경우, 사용자의 인지 오류가 아니라 AI 오류이므로 이상으로 채점하지 마세요(score 0).
   - ⚠️ **명시적 회상·자기불확실 표현이 같은 발화에 동반되면 한 단계 낮춰 score 1**: "옛날에/예전에/어릴 때/그때/젊었을 때", "~생각이 나서/나네", "헷갈리네/가물가물", "잘 모르겠네" 같은 **과거 회상 또는 본인이 헷갈려함을 명시**한 표현이 함께 있을 때만 score 2 → 1로 강등.
     ⛔ 단순 꼬리표 의문("~이지?", "~맞지?", "~인가?")만으로는 강등하지 마세요 — 이는 확신에 찬 단정의 어투일 뿐 불확실이 아닙니다. 예: "오늘 2003년 3월이지?"는 확신 오답 → **score 2 유지**.
   - 예: "올해가 한 2010년인가? 아 옛날 생각이 자꾸 나서 헷갈리네" → 틀린 연도 + 명시적 회상·불확실("옛날 생각", "헷갈리네") → score 1
   - 예: "오늘 2003년이야" / "오늘 2003년 3월이지?"(확신 단정) → score 2

2. 장소 지남력 (orientation_place):
   - 현재 위치와 다른 장소에 있다고 말함 → score 2
   - 환경 정보의 사용자 위치를 기준으로 판단하세요
   - 예: 동탄에 있는데 "나 지금 뉴욕에 있어", "여기 부산이잖아"
   - ⚠️ **회상 신호가 같은 발화에 동반되면 보수적으로 판단**: "옛날에", "예전에", "결혼하고", "젊었을 때", "쭉 살았어", "태어났", "어릴 때" 같은 과거 회상 표현이 같은 메시지 안에 함께 있으면 score를 한 단계 낮추세요 (2→1, 1→체크 자체 제외). 사용자가 다음 턴에 자기 정정할 가능성이 있어 1턴만으로 score=2 단정은 오탐 위험.
   - 예: "부산에 살지. 결혼하고 부산으로 와서 쭉 살았어" → "결혼하고"+"쭉 살았어" 회상 신호 동반 → score 1 (또는 신중 보류)
   - 예: "지금 뉴욕에 있어" 단독 → score 2 (회상 신호 없음)

3. 판단력 (judgment):
   - 과거에 끝난 사건을 현재 일어나는 것처럼 말함 → score 2
   - 이미 사망한 인물을 만나겠다/만났다/같이 했다고 함 (어떤 시제든) → score 2
   - 비현실적 경험 (외계인, 공룡 등) → score 2
   - 상황에 맞지 않는 행동 계획 (폭우에 반팔, 새벽 3시에 시장) → score 2
   - 예: "911테러가 방금 일어났어", "박정희 각하를 만나뵙기로 했어", "새마을운동 하러 가야지"
   - 예(과거형): "어제 박정희 대통령이 우리집에 왔어", "지난주에 김구 선생이랑 차 한잔 했어" → 사망 인물과의 최근 일상 접촉 묘사도 즉시 score 2
   - ⚠️ 사용자가 곧바로 "꿈에서 본 거였나" 처럼 자기 정정해도, 직전 발화 자체는 isAnomaly 처리하세요. 정정은 후속 turn의 judgment score=0 evidence가 됩니다.
   - ✅ **정상도 반드시 기록**: 직전 AI가 판단력 질문(지갑 주우면?/불나면?/공통점?/약 깜빡하면? 등)을 했고 사용자가 **적절히 답하면 judgment score 0으로 반드시 cognitiveCheck를 생성**하세요 (재질문 방지·기록 누락 방지). 예: AI "지갑 주우면?" → 사용자 "경찰서에 갖다줘야지" → {"domain":"judgment","score":0,"evidence":"적절한 사회적 판단","note":"정상"}

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
   - AI가 "아까 외워주신 단어 세 개"(나무/자동차/모자 등 MMSE-K 3단어) 회상 요청 → 사용자가 0~1개만 회상 → score 2, 2개 → score 1
   - AI가 MoCA-K 5단어(얼굴/비단/교회/카네이션/빨강) 회상 요청 → 사용자가 0~1개 회상 → score 2, 2~3개 → score 1
   - ⏱️ **시간 경과로 단어를 잊는 건 정상 — 오래전 등록은 채점 제외**:
     · 회상 실패를 채점하기 전, 최근 맥락에서 그 **단어를 외운(등록한) AI 발화의 시간 라벨**을 확인하세요.
     · 등록 발화가 보이고 그 라벨이 **[어제]/[N일 전]/[1주일 전]/[오래 전]** 등 오래 전이면 → 시간이 지나 잊는 건 누구나 정상입니다. **무판정(cognitiveCheck 미생성)**, 절대 score 1/2로 잡지 마세요. (지연회상은 임상적으로 등록 후 수분~수시간 내에만 유효한 검사입니다.)
     · 등록 라벨이 **[방금]~[N시간 전](당일·같은 대화)**이거나, 등록 시점이 맥락에 안 보여 불명확하면 → 평소대로 채점하세요(같은 세션 회상으로 간주).
     · 이 시간 규칙은 "외운 단어·숫자" 같은 **임의 등록 항목**에만 적용됩니다. 가족 이름·고향 등 자전적 기억은 시간과 무관하게 평가하세요.
   - ⛔ **사용자가 회상 거부·화제 전환 시 점수 무판정**:
     · 예: AI "아까 외운 단어 기억나세요?" → 사용자 "단어 외운 건 됐고 무릎이 더 문제야" → 이건 **회상 거부/화제 전환**이지 회상 실패가 아닙니다. memory_delayed 점수 무판정 (cognitiveCheck 미생성).
     · 예: AI 단어 회상 요청 → 사용자 "그건 그렇고 점심 뭐 먹지" → 화제 전환, 점수 무판정.
     · 사용자가 명시적으로 응답을 회피하면 인지 이상이 아닌 의사 결정으로 해석. 인지 평가는 사용자가 실제로 답을 시도한 경우에만.
   - ⛔ **가족 관계·순서 판단 시 절대 주의**:
     · 사용자가 과거 발화에서 "큰아들=A, 둘째=B"로 명시했다면 그 관계는 **사용자가 명시적으로 정정하지 않는 한 변경되지 않은 것**으로 간주하세요.
     · 직전 발화에 "재미는 그 옆에서 형 놀린다고"가 있고 다음 발화에 "큰아들이 재미야"가 나와도, 이건 모순이 아닙니다 — "형 놀린다"의 "형"은 본인(재미)이 아니라 다른 자녀(영민)를 지칭할 수 있고, 사용자는 일관되게 "큰아들=재미"라고 말하는 중입니다.
     · 가족 순서 혼동(memory_delayed score=2)으로 판정하려면 **사용자가 명시적으로 두 다른 발화에서 모순된 관계를 진술해야** 합니다 (예: 어떤 발화 "큰아들 영민", 다른 발화 "큰아들 재미").
     · 그렇지 않으면 score=0(정상). RAG/맥락에 못 잡힌 자녀 이름이라 해서 ‘가족 이름 못 기억’으로 판단 금지 — 이는 RAG의 한계이지 사용자의 인지 문제가 아닙니다.

6. 언어 유창성 (language):
   - "그거", "저기", "뭐시기" 과다 사용, 단어 찾기 어려움 → score 2
   - AI가 "1분 안에 동물 이름 최대한" 요청(의미 유창성) → 사용자가 5개 미만 → score 2, 5~8개 → score 1
   - AI가 "'ㅁ'으로 시작하는 단어" 요청(음소 유창성) → 사용자가 3개 미만 → score 2
   - AI가 따라말하기 요청("간장 공장 공장장…") → 절반 이하 정확도 → score 2
   - AI가 속담/은유 의미 질문("백문이 불여일견 무슨 뜻?") → 사용자가 글자 그대로 해석하거나 모르겠다고 함 → score 1 (단, 학력 낮으면 정상일 수 있어 신중)
   - AI가 이름대기(우회적 설명 → 사물 이름) 요청 → 정답 못 댐 → score 2

7. 주의력/계산 (attention_calculation):
   - **⚠️ 계산 vs 기억 혼동 금지**: 직전 AI 발화에 "빼면/더하면/곱하면/나누면/N에서 M을/100-7" 같은 **명시적 계산 표현**이 있고 사용자가 단순 숫자로 답했다면, 그 답의 정/오는 **반드시 attention_calculation 한 영역**으로만 판정하세요. 답이 사용자의 환경 나이/생년 등과 우연히 어긋나더라도 **memory_delayed로 분류 금지**. 즉 "AI가 계산을 물었으면 답은 계산 영역으로만 본다".
   - AI가 **명시적으로 계산 문제**를 냈는데 사용자가 **틀린 숫자**로 답 → score 2
     예: AI "100-7은?" → 사용자 "85" (정답 93) → score 2
     예: AI "만원 내면 거스름돈은?" → 사용자 "3천원" (정답 다름) → score 2
   - AI가 "100에서 7씩 연속으로 빼기" 요청(MMSE-K) → 5단계 중 2회 이상 오류 → score 2, **1회만 오류 또는 1회 머뭇·자가수정(예: "85? 아니 86인가 헷갈리네")이면 → score 1(경계)**
   - AI가 "삼천리강산 거꾸로" 요청(MMSE-K) → 정상 순서 또는 1글자 이상 오류 → score 2
   - AI가 숫자 N개 따라하기 요청(MoCA-K) → 절반 이상 오류 → score 2
   - AI가 숫자 거꾸로 따라하기 요청 → 실패 → score 2
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

/**
 * AI 발화에서 인지 선별 질문 패턴을 검출 → 해당 도메인을 자동 등록(중복 방지).
 *
 * 배경: 분석기 LLM이 사용자 답변 기준으로만 도메인 태깅하면 AI가 같은 질문(속담/따라말하기 등)을
 * 세션 내 반복 출제한다. AI 발화 자체에서 패턴이 보이면 score=0으로 즉시 cognitive_assessments에
 * 박아 둬서 다음 턴 prompt의 "이미 확인한 영역"에 반영시킨다.
 *
 * 의도적으로 보수적이어서 오탐을 최소화한다: 진짜 cognitive 검사 표현만 매칭.
 */
const COGNITIVE_QUESTION_PATTERNS: Array<{ domain: string; pattern: RegExp }> = [
  // 언어 — 속담/관용구 의미 질문
  { domain: "language", pattern: /(백문이 불여일견|티끌 모아 태산|호랑이도 제 말 하면|소문난 잔치|세 살 (?:적|버릇)|아니 땐 굴뚝|등잔 밑이 어둡|돌다리도 두들겨|가는 말이 고와야)/ },
  { domain: "language", pattern: /(?:속담|관용구).*(?:무슨\s*뜻|뜻이\s*뭐)/ },
  // 언어 — 따라말하기 (간장 공장…)
  { domain: "language", pattern: /(간장\s*공장\s*공장장|저기 저 분이|중앙청 창살)/ },
  { domain: "language", pattern: /(?:똑같이\s*따라|그대로\s*따라|이대로\s*따라|따라\s*해\s*보세|따라\s*말씀해)/ },
  // 언어 — 의미·음소 유창성
  { domain: "language", pattern: /(?:1분\s*안에|일\s*분\s*안에|최대한\s*많이).*(?:동물|음식|과일|단어)/ },
  { domain: "language", pattern: /(?:'[가-힣]'|"[가-힣]"|[가-힣])(?:로|으로)\s*시작하는\s*(?:동물|단어|음식|이름)/ },
  // 즉시/지연 기억
  { domain: "memory_immediate", pattern: /(?:방금|지금)\s*(?:외워|기억해)\s*(?:두|보세|주세)/ },
  { domain: "memory_delayed", pattern: /(?:아까|좀\s*전에)\s*(?:외워|드린|말씀드린)\s*(?:단어|세\s*개|세개|3개|다섯\s*개|5개)/ },
  { domain: "memory_delayed", pattern: /(?:아까|좀\s*전에).*(?:기억\s*나|회상해)/ },
  // 주의력/계산
  { domain: "attention_calculation", pattern: /\d+\s*에서\s*\d+\s*(?:을|를)?\s*(?:빼|더|곱|나눠|나누)/ },
  { domain: "attention_calculation", pattern: /100\s*에서\s*7\s*씩|삼천리강산.*거꾸로|만원\s*내(?:면|고).*거스름/ },
  // 시간 지남력
  { domain: "orientation_time", pattern: /오늘\s*(?:무슨\s*요일|며칠|몇\s*월|날짜)|지금\s*몇\s*시|올해\s*몇\s*년|지금이\s*(?:몇년|몇\s*년)/ },
  { domain: "orientation_time", pattern: /요즘\s*무슨\s*계절|지금\s*무슨\s*계절/ },
  // 장소 지남력
  { domain: "orientation_place", pattern: /(?:지금|할아버지|할머니)\s*(?:어디|어느\s*곳).*계세|여기(?:가)?\s*어디/ },
  // 판단력
  { domain: "judgment", pattern: /(?:길에서\s*지갑(?:을|를)?\s*주우면|불이\s*났을\s*때|화재.*어떻게|약을\s*잘못\s*드시면)/ },
];

function detectCognitiveQuestions(aiResponse: string): string[] {
  const out = new Set<string>();
  for (const { domain, pattern } of COGNITIVE_QUESTION_PATTERNS) {
    if (pattern.test(aiResponse)) out.add(domain);
  }
  return Array.from(out);
}

function ensureCognitiveDomainLogged(
  result: CognitiveAnalysisResult,
  aiResponse: string,
): CognitiveAnalysisResult {
  const detected = detectCognitiveQuestions(aiResponse);
  if (detected.length === 0) return result;
  const existing = new Set(result.cognitiveChecks.map((c) => c.domain));
  const additions = detected
    .filter((d) => !existing.has(d))
    .map((domain) => ({
      domain,
      score: 0,
      confidence: 0.6,
      evidence: "대화 중 정상 범위로 확인됨",
      note: "정상",
    }));
  if (additions.length === 0) return result;
  return { ...result, cognitiveChecks: [...result.cognitiveChecks, ...additions] };
}

/**
 * 직전 AI 발화에 명시적 계산 표현이 있고 사용자가 숫자 위주로 답한 경우,
 * 잘못 분류된 memory_delayed/memory_immediate를 attention_calculation으로 정정.
 *
 * 케이스: AI "79에서 7 빼면?" → 사용자 "70" → LLM이 "79세→70세 나이 불일치"로 memory_delayed 오판.
 * 실제론 계산 오답이므로 attention_calculation 영역으로 재배정해야 한다.
 */
const CALC_QUESTION_PATTERN = /(?:\d+\s*(?:에서|-)\s*\d+\s*(?:을|를)?\s*(?:빼|더|곱|나눠|나누))|(?:\d+\s*[+\-*×÷]\s*\d+)|(?:거스름돈|얼마|몇|덧셈|뺄셈|곱셈|나눗셈|계산)/;
// 숫자 위주 답변: 아라비아 숫자 또는 Sino-Korean 수사(영/일/이/삼/사/오/육/칠/팔/구/십/백/천/만)
// + 선택적 단위(원/개/살/세) — "기억이 안 나요" 같은 일반 한글은 매칭 안 되도록 가-힣은 제외
const NUMERIC_REPLY_PATTERN = /^\s*(?:\d+|[영일이삼사오육칠팔구십백천만\s]+)\s*(?:원|개|살|세|점|등)?\s*[.!?~]?\s*$/;

function extractLastAiMessage(historyText: string): string {
  const lines = historyText.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:AI|assistant|Assistant|민지|ai)\s*[:：]\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

/**
 * 사망인물·비현실 명시 발화는 LLM이 누락할 수 있어 휴리스틱 안전망으로 강제 marking.
 * 동작: 사용자 발화에 (사망인물 ∪ 비현실 생물) + (최근 시점 동사) 패턴이 같이 있으면
 *      judgment score=2를 강제 주입하고 isAnomaly=true 설정.
 */
const DECEASED_FIGURES = /(박정희|이승만|전두환|김구|김대중|노무현|이순신|세종대왕|광개토|영조|정조|숙종|태조|마더\s*테레사|히틀러|마오쩌둥|레닌|스탈린)/;
const SURREAL_BEINGS = /(외계인|공룡|UFO|도깨비|유령|화단에\s*호랑이|마당에\s*호랑이|거실에\s*사자|집에서\s*호랑이)/;
const RECENT_TIME_CONTACT = /(어제|오늘|방금|아까|지금|이번\s*주|지난\s*주|아침|저녁|점심).*(만났|만나|왔|와서|봤|보았|먹었|마셨|했|같이|차\s*한잔|대화|이야기)|(만났|왔|봤|먹었|같이|차\s*한잔).*(어제|오늘|방금|아까|지금|이번\s*주|지난\s*주)/;

function injectJudgmentSafetyNet(
  result: CognitiveAnalysisResult,
  userMessage: string,
): CognitiveAnalysisResult {
  const text = userMessage;
  const hasDeceasedOrSurreal = DECEASED_FIGURES.test(text) || SURREAL_BEINGS.test(text);
  if (!hasDeceasedOrSurreal) return result;
  const isRecentContact = RECENT_TIME_CONTACT.test(text) || SURREAL_BEINGS.test(text);
  if (!isRecentContact) return result;

  const already = result.cognitiveChecks.find((c) => c.domain === "judgment");
  if (already && already.score >= 2) return result;

  const matched = (text.match(DECEASED_FIGURES) || text.match(SURREAL_BEINGS) || [""])[0];
  const newCheck = {
    domain: "judgment",
    score: 2,
    confidence: 0.95,
    evidence: `휴리스틱 안전망: "${matched}" + 최근 접촉 시제 동반`,
    note: "사망인물 또는 비현실 대상과의 최근 접촉 묘사 — judgment 안전망 강제 마킹",
  };
  const filtered = result.cognitiveChecks.filter((c) => c.domain !== "judgment");
  return {
    ...result,
    isAnomaly: true,
    analysisNote: result.analysisNote
      ? `${result.analysisNote} | 안전망: ${matched}+최근시제`
      : `[안전망] 사망/비현실(${matched}) + 최근 시제 동반`,
    cognitiveChecks: [...filtered, newCheck],
  };
}

function reclassifyCalculation(
  result: CognitiveAnalysisResult,
  userMessage: string,
  historyText: string,
): CognitiveAnalysisResult {
  const lastAi = extractLastAiMessage(historyText);
  if (!lastAi || !CALC_QUESTION_PATTERN.test(lastAi)) return result;

  const userOnlyNumber = NUMERIC_REPLY_PATTERN.test(userMessage) && /[\d일이삼사오육칠팔구십]/.test(userMessage);
  if (!userOnlyNumber) return result;

  // memory_delayed/memory_immediate가 anomaly로 잡혔으면 → attention_calculation으로 교체
  const misclassified = result.cognitiveChecks.filter((c) => (c.domain === "memory_delayed" || c.domain === "memory_immediate") && c.score >= 1);
  if (misclassified.length === 0) return result;

  const hasCalc = result.cognitiveChecks.some((c) => c.domain === "attention_calculation");
  let newChecks = result.cognitiveChecks.filter((c) => c.domain !== "memory_delayed" && c.domain !== "memory_immediate");
  if (!hasCalc) {
    const worstScore = Math.max(...misclassified.map((c) => c.score));
    newChecks = [
      ...newChecks,
      {
        domain: "attention_calculation",
        score: worstScore,
        confidence: 0.7,
        evidence: `직전 AI 계산 질문에 숫자 답("${userMessage.slice(0, 40)}") 오분류 보정`,
        note: "memory→attention_calculation 재배정",
      },
    ];
  }
  return {
    ...result,
    cognitiveChecks: newChecks,
    analysisNote: result.analysisNote.replace(/(?:연세|나이|생년).*?(?:불일치|틀림|차이)/g, "계산 영역 재배정").slice(0, 500),
  };
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
      // 분석기 모델 — 기본 3.5. 모델 비교용으로 COGNITIVE_MODEL env로 오버라이드 가능.
      model: process.env.COGNITIVE_MODEL || "gemini-3.5-flash",
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: "application/json" },
    });

    const historyLines = params.historyText.split("\n");
    const recentHistory = historyLines.slice(-10).join("\n");

    // 사투리 정규화 — 인지 분석은 표준어 기준으로 빈도·문법 평가 → false positive 감소
    //   UI 응답에는 원문이 그대로 들어가므로 사용자 정체성/말투는 보존됨.
    const normalized = normalizeDialect(params.userMessage);
    const userForAnalysis = normalized.changes.length > 0 ? normalized.normalized : params.userMessage;
    if (normalized.changes.length > 0) {
      console.log("[dialect-normalize]", JSON.stringify({
        original: params.userMessage,
        normalized: normalized.normalized,
        regions: normalized.changes.map((c) => c.region),
      }));
    }

    const promptText = `${PROMPT}\n\n${params.envBlock}\n\n최근 대화 맥락:\n${recentHistory}\n\n[이번 턴 — 이것만 분석하세요]\n사용자: ${userForAnalysis}\nAI: ${params.assistantResponse}`;
    // transient 장애(503/429/네트워크) 시 재시도 — Gemini 일시 과부하로 인지 평가가 통째 유실되는 것 방지.
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await model.generateContent(promptText);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /\b(503|429)\b|Service Unavailable|overloaded|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET|ETIMEDOUT|deadline/i.test(msg);
        if (transient && attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    const raw = parseResult(res.response.text().trim());
    const memValidated = validateMemoryImmediate(raw, userForAnalysis, recentHistory);
    const calcReclassified = reclassifyCalculation(memValidated, userForAnalysis, recentHistory);
    const safetyNetted = injectJudgmentSafetyNet(calcReclassified, userForAnalysis);
    return ensureCognitiveDomainLogged(safetyNetted, params.assistantResponse);
  } catch (e) {
    console.warn("Cognitive analyzer error:", e);
    return { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };
  }
}
