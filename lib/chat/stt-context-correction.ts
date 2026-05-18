/**
 * 맥락 기반 STT 후처리 — 직전 AI 발화 도메인에 맞춰 노인 발음 오인식 교정.
 *
 * 배경: 노인 화자의 STT 결과는 어휘 단위에서 음운 변화·틀니 마찰음으로 자주 어긋남.
 * 예: AI "점심 뭐 드셨어요?" → STT "미빈밥" → 일반 어휘 사전엔 없는 단어 → 인지 분석기가
 *      "language" 이상으로 오판할 위험. 직전 AI 질문이 음식 도메인이면 "비빔밥"으로 보정.
 *
 * 정책:
 * - 도메인 트리거가 명확히 매칭될 때만 적용 (false correction 최소화)
 * - 단방향 매핑만(wrong → right). 양방향 동의어는 정상 발화도 변조할 수 있으므로 금지.
 * - 한글 substring 단순 치환. "비빔밥을" 같은 조사 결합어도 자연스럽게 보존.
 */

export interface CorrectionChange {
  from: string;
  to: string;
  domain: string;
}

export interface CorrectionResult {
  corrected: string;
  changes: CorrectionChange[];
}

interface CorrectionDomain {
  name: string;
  /** AI 직전 발화에 매칭되면 이 도메인으로 인식 */
  triggers: RegExp;
  /** [오인식, 정답] 쌍 */
  pairs: Array<[string, string]>;
}

const DOMAINS: CorrectionDomain[] = [
  {
    name: "food",
    triggers: /(?:점심|아침|저녁|식사|뭐\s*드셨|뭘\s*드셨|메뉴|음식|요리|반찬|드시고|드실)/,
    pairs: [
      // 비빔밥
      ["미빈밥", "비빔밥"], ["비빈밥", "비빔밥"], ["비빔법", "비빔밥"], ["비빔빱", "비빔밥"],
      // 김치찌개
      ["김찌지개", "김치찌개"], ["김치지께", "김치찌개"], ["김치 지께", "김치찌개"], ["김치지개", "김치찌개"],
      // 미역국
      ["미여국", "미역국"], ["미욱국", "미역국"], ["미녁국", "미역국"],
      // 된장찌개
      ["덴장지개", "된장찌개"], ["된장지개", "된장찌개"], ["된장 지께", "된장찌개"],
      // 떡국
      ["덕국", "떡국"], ["떡쿡", "떡국"],
      // 누룽지
      ["누룽치", "누룽지"], ["누릉지", "누룽지"],
      // 부침개
      ["부참개", "부침개"], ["부친개", "부침개"],
      // 김밥
      ["김벹", "김밥"], ["김반", "김밥"],
      // 콩나물
      ["콩나무", "콩나물"], ["콘나물", "콩나물"],
      // 시금치
      ["시금지", "시금치"], ["스금치", "시금치"],
    ],
  },
  {
    name: "medication",
    // "약은 잘 드셨" 처럼 약과 동사 사이에 조사/부사가 끼어도 매칭
    triggers: /(?:약[^.!?]{0,8}(?:드셨|드시|복용|챙겨|먹었|드릴|언제)|복약|혈압|당뇨|진통제|영양제|처방)/,
    pairs: [
      // 혈압약
      ["혈양약", "혈압약"], ["혈양야꾸", "혈압약"], ["혈약", "혈압약"], ["혈압야꾸", "혈압약"],
      // 당뇨약
      ["당뇨야꾸", "당뇨약"], ["당노약", "당뇨약"], ["당료약", "당뇨약"],
      // 진통제
      ["진통재", "진통제"], ["진툼제", "진통제"],
      // 영양제
      ["영양재", "영양제"], ["영냥제", "영양제"],
      // 소화제
      ["소화재", "소화제"], ["조화제", "소화제"],
      // 수면제
      ["수면재", "수면제"], ["수멸제", "수면제"],
    ],
  },
  {
    name: "place",
    // "어디 사세요/살아요/사시는지" 등 살다 활용형 포함
    triggers: /(?:어디.*(?:계세|살|사세|사시|사신)|동네|어느\s*동|위치|어느\s*시|어느\s*구|고향)/,
    pairs: [
      // 동탄
      ["동탕", "동탄"], ["동타", "동탄"],
      // 화성
      ["하성", "화성"], ["화송", "화성"],
      // 수원
      ["수운", "수원"], ["스원", "수원"],
      // 일상 장소
      ["노이정", "노인정"], ["노인저", "노인정"],
      ["경노당", "경로당"], ["견로당", "경로당"],
      ["약슬터", "약수터"], ["약습터", "약수터"],
      ["복지간", "복지관"], ["복찌관", "복지관"],
      ["교회당", "교회"], // 종종 STT가 늘려 인식
    ],
  },
  {
    name: "family",
    triggers: /(?:아드님|따님|손자|손녀|손주|며느리|사위|가족|자녀|자식|아들|딸)/,
    pairs: [
      // 흔한 친족 호칭 오인식
      ["아드람", "아드님"], ["아들임", "아드님"],
      ["며느니", "며느리"], ["며누리", "며느리"],
      ["손주", "손주"], // identity (변화 없음 — 단순 노이즈)
      ["손짜", "손자"],
      ["손냐", "손녀"],
    ],
  },
];

/**
 * 직전 AI 발화에 따라 사용자 STT 결과 보정.
 * @returns 보정 결과 + 변경 내역 (로그/디버깅용)
 */
export function correctTranscriptionByContext(
  transcription: string,
  lastAiMessage: string,
): CorrectionResult {
  const empty: CorrectionResult = { corrected: transcription, changes: [] };
  if (!transcription || !lastAiMessage) return empty;

  let corrected = transcription;
  const changes: CorrectionChange[] = [];

  for (const domain of DOMAINS) {
    if (!domain.triggers.test(lastAiMessage)) continue;
    for (const [wrong, right] of domain.pairs) {
      if (wrong === right) continue;             // 자기 자신 매핑 방지
      if (!corrected.includes(wrong)) continue;  // 매칭 없음
      corrected = corrected.split(wrong).join(right);
      changes.push({ from: wrong, to: right, domain: domain.name });
    }
  }

  return { corrected, changes };
}
