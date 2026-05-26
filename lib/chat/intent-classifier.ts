/**
 * 사용자 발화 의도 분류 — prompt 분기 처리로 안전성·정확성 향상.
 *
 * 분류 카테고리:
 *   - info_request: 사용자가 직접 정보 요청 ("이름 뭐였지?", "기억해?")
 *     → RAG/profile 활용 강제, 평가 핑계 금지
 *   - emotional: 감정 호소 (사별/외로움/그리움) 또는 신체 통증
 *     → 공감 머무름, 인지 질문 즉시 전환 금지
 *   - cognitive_anomaly: 이상 행동 (사망인물/비현실/시점혼동)
 *     → 안전망 환기, 동조 금지
 *   - daily: 일상 대화 (식사/날씨/취미)
 *     → 일반 follow-up + 인지 평가 자연 끼움 가능
 *
 * 다중 분류 가능 (예: 통증 + 정보 요청). 우선순위: cognitive_anomaly > emotional > info_request > daily
 *
 * 정규식 기반 (LLM 비용 절약). hintBlock에 결과 주입하여 prompt 분기.
 */

export type Intent = "info_request" | "emotional" | "cognitive_anomaly" | "daily";

const INFO_REQUEST_PATTERNS = [
  /기억하지|기억해\??|기억나|기억\s*[음어]/,
  /알려\s*줘|알려\s*주|얘기해\s*줘/,
  /뭐였더라|뭐였지|뭐였어|뭐였[을나]|뭐였던/,
  /누구였|누군지|누구지|누구야|누가/,
  /어디였|어딘지|어디지|어디야/,
  /언제였|언젠지|언제지|언제야/,
  /헷갈리네|헷갈려|까먹었|까먹어/,
  /모르겠어|모르겠다|잊어버렸/,
];

const EMOTIONAL_PATTERNS = [
  // 사별/그리움
  /돌아가|먼저\s*떠난|먼저\s*간|먼저\s*갔|사별|그립|보고\s*싶/,
  /외롭|쓸쓸|허전|적적/,
  // 신체 통증·건강
  /아파|아프|아픈|아프네|아프더|아프고|아팠/,
  /시큰|쑤시|결리|뻐근/,
  /병원|약\s*먹|복용/,
  /잠\s*못\s*[자잤지]|잠이\s*안|잠\s*안\s*[와오]/,
  /어지러|기절|쓰러/,
  // 우울/불안
  /우울|불안|걱정|괴롭|힘들/,
];

const COGNITIVE_ANOMALY_PATTERNS = [
  // 사망인물 + 최근 시제
  /(?:박정희|이승만|전두환|김구|김대중|노무현|이순신|세종|김일성|김정일|히틀러|마오쩌둥)/,
  // 비현실 생물
  /외계인|UFO|공룡|도깨비|유령|마당에\s*호랑이|화단에\s*호랑이/,
  // 시점 혼동
  /오늘.*(?:19[5-9]\d|200\d|201\d|203\d|204\d|205\d)년|오늘이?\s*(?:19[5-9]\d|20[0-2]\d|203\d|204\d|205\d)년/,
  /지금.*(?:19[5-9]\d|200\d|201\d|203\d|204\d|205\d)년/,
  // 비현실 장소 (과거 회상 표현 없을 때만 의미)
  /(?:하와이|미국\s*LA|뉴욕|에펠탑|도쿄|일본\s*도쿄|오사카)/,
];

interface IntentResult {
  intents: Intent[];
  primary: Intent;
}

export function classifyIntent(userMessage: string): IntentResult {
  if (!userMessage) return { intents: ["daily"], primary: "daily" };
  const text = userMessage.trim();
  const intents: Intent[] = [];

  if (COGNITIVE_ANOMALY_PATTERNS.some((p) => p.test(text))) intents.push("cognitive_anomaly");
  if (EMOTIONAL_PATTERNS.some((p) => p.test(text))) intents.push("emotional");
  if (INFO_REQUEST_PATTERNS.some((p) => p.test(text))) intents.push("info_request");

  if (intents.length === 0) intents.push("daily");

  // 우선순위: cognitive_anomaly > emotional > info_request > daily
  const priority: Intent[] = ["cognitive_anomaly", "emotional", "info_request", "daily"];
  const primary = priority.find((p) => intents.includes(p)) || "daily";

  return { intents, primary };
}

/** Intent 결과를 prompt hintBlock에 주입할 짧은 가이드 텍스트로 변환 */
export function buildIntentHint(result: IntentResult, honorific: string): string {
  switch (result.primary) {
    case "cognitive_anomaly":
      return `\n[🧠 의도 분류: 이상 발화 감지 — 안전망 모드]
사용자 발화에 사망인물·비현실·시점 혼동 등 인지 이상 신호가 있습니다.
- 동조하지 마세요 ("정말 놀랍네요" 같은 표현 금지)
- "꿈/TV에서 보신 거 아닐까요?" 식으로 부드럽게 환기
- 사용자 자존심 다치지 않게 차분한 톤`;

    case "emotional":
      return `\n[💚 의도 분류: 감정 호소·통증 — 공감 모드]
사용자가 슬픔/그리움/통증/외로움 등을 표현했습니다.
- 충분히 공감하세요 ("많이 힘드시겠어요", "그리우시죠")
- 그 주제에 최소 한 턴 머물기. 식사·일상 화제로 즉시 전환 금지
- 인지 평가 질문(단어 외우기/계산) 절대 금지`;

    case "info_request":
      return `\n[📚 의도 분류: 정보 요청 — RAG 답변 모드]
사용자가 직접 정보를 요청했거나 헷갈려합니다.
- [참고 — 과거 메모리]나 [사용자 확정 정보]에 답이 있으면 솔직히 알려주세요
- "민지가 깜빡했어요" 같은 평가용 핑계 절대 금지
- 정보가 없으면 솔직히 "기억이 안 나요, 알려주시겠어요?" 인정`;

    case "daily":
    default:
      return ``;  // 일상 대화는 별도 가이드 불필요 (기본 prompt 그대로)
  }
}
