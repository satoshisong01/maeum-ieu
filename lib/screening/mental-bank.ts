/**
 * T3 정신건강 검진 — 척도 정의 (docs/T3_정신건강_설계.md §2).
 * PHQ-9: 공개 척도. 대화형 변형은 의미 보존 원칙(묻는 내용 유지, 말투만 부드럽게) — 임의 의역 금지.
 * 응답 매핑: 전혀 없음 0 / 며칠 동안 1 / 절반 이상 2 / 거의 매일 3 (지난 2주 기준).
 */

export interface MentalItem {
  no: number;
  key: string;
  /** 원문항 요지 (검증·문서용) */
  original: string;
  /** 대화형 변형 — 재질문 시 다른 변형 사용 */
  variants: string[];
  /** true면 점수 ≥1 시 즉시 위기 안내 (PHQ-9 9번 자해사고) */
  crisis?: boolean;
}

export const PHQ9_ITEMS: MentalItem[] = [
  {
    no: 1, key: "interest", original: "일 또는 여가 활동에 대한 흥미나 즐거움 저하",
    variants: [
      "지난 2주 동안, 평소 좋아하시던 일이 재미없거나 흥미가 안 생긴 날이 얼마나 있었어요?",
      "요즘 2주 사이에 어떤 일에도 즐거움을 못 느낀 날이 자주 있었나요?",
    ],
  },
  {
    no: 2, key: "depressed", original: "기분 저하, 우울감, 절망감",
    variants: [
      "기분이 가라앉거나, 우울하거나, 희망이 없다고 느낀 날은 어느 정도였어요?",
      "지난 2주간 마음이 무겁고 처지는 날이 얼마나 자주 있었나요?",
    ],
  },
  {
    no: 3, key: "sleep", original: "수면 문제 (잠들기 어려움, 자주 깸, 과다 수면)",
    variants: [
      "잠들기 어렵거나 자다 자주 깨거나, 반대로 너무 많이 잔 날이 많았나요?",
      "지난 2주 동안 잠 때문에 고생한 날은 어느 정도였어요?",
    ],
  },
  {
    no: 4, key: "fatigue", original: "피곤함, 기력 저하",
    variants: [
      "기운이 없고 쉽게 피곤해진 날은 얼마나 자주 있었어요?",
      "지난 2주간 몸에 힘이 없다고 느낀 날이 많았나요?",
    ],
  },
  {
    no: 5, key: "appetite", original: "식욕 저하 또는 과식",
    variants: [
      "입맛이 없거나, 반대로 너무 많이 드시게 되는 일은 어느 정도였어요?",
      "지난 2주 동안 식사가 평소와 달라진 날(잘 못 먹거나 과식)이 자주 있었나요?",
    ],
  },
  {
    no: 6, key: "guilt", original: "자책감, 실패감, 가족 실망감",
    variants: [
      "스스로가 실패자 같다거나, 자신이나 가족을 실망시켰다는 생각이 든 날이 있었어요?",
      "지난 2주간 자신을 탓하는 생각이 얼마나 자주 들었나요?",
    ],
  },
  {
    no: 7, key: "concentration", original: "집중 곤란 (신문 읽기, TV 시청 등)",
    variants: [
      "신문을 읽거나 TV를 볼 때 집중하기 어려운 날이 많았나요?",
      "지난 2주 동안 뭔가에 집중이 잘 안 된 날은 어느 정도였어요?",
    ],
  },
  {
    no: 8, key: "psychomotor", original: "정신운동 지연 또는 초조 (느려짐/안절부절)",
    variants: [
      "말이나 행동이 평소보다 눈에 띄게 느려졌거나, 반대로 안절부절못해 가만히 있기 힘든 날이 있었어요?",
      "주변에서 평소보다 느려졌다거나 들떠 보인다고 할 정도의 날이 지난 2주간 얼마나 있었나요?",
    ],
  },
  {
    no: 9, key: "selfharm", original: "자해·죽음에 대한 생각", crisis: true,
    variants: [
      "혹시 차라리 없어지는 게 낫겠다거나, 스스로를 해치고 싶다는 생각이 든 적이 있으셨어요?",
      "지난 2주 동안 죽고 싶다거나 자신을 해치는 생각이 떠오른 날이 있었나요?",
    ],
  },
];

/** GAD-7 (불안, 공개 척도) — 같은 빈도 매핑(0~3), 합계 0~21 */
export const GAD7_ITEMS: MentalItem[] = [
  { no: 1, key: "nervous", original: "초조하거나 불안하거나 조마조마함", variants: [
    "지난 2주 동안, 초조하거나 불안하고 조마조마한 날이 얼마나 있었어요?",
    "요즘 2주 사이 마음이 불안하고 안절부절못한 날이 자주 있었나요?",
  ] },
  { no: 2, key: "control", original: "걱정을 멈추거나 조절할 수 없음", variants: [
    "걱정이 한번 시작되면 멈추거나 다스리기 어려운 날은 어느 정도였어요?",
    "걱정을 스스로 조절하기 힘들다고 느낀 날이 지난 2주간 얼마나 있었나요?",
  ] },
  { no: 3, key: "worry", original: "여러 가지에 대해 지나치게 걱정함", variants: [
    "이런저런 일들을 지나치게 걱정한 날이 많았나요?",
    "지난 2주 동안 사소한 일까지 너무 걱정된 날은 어느 정도였어요?",
  ] },
  { no: 4, key: "relax", original: "긴장을 풀기 어려움", variants: [
    "마음 편히 쉬거나 긴장을 풀기 어려운 날이 얼마나 있었어요?",
    "몸과 마음이 잘 안 풀리고 계속 긴장돼 있던 날이 많았나요?",
  ] },
  { no: 5, key: "restless", original: "가만히 있지 못할 정도로 안절부절못함", variants: [
    "가만히 앉아 있기 힘들 만큼 안절부절못한 날이 있었어요?",
    "지난 2주간 들떠서 진정이 안 되는 날은 어느 정도였나요?",
  ] },
  { no: 6, key: "irritable", original: "쉽게 짜증이 나거나 화가 남", variants: [
    "쉽게 짜증이 나거나 욱하게 된 날이 얼마나 있었어요?",
    "평소보다 화가 잘 나는 날이 지난 2주간 자주 있었나요?",
  ] },
  { no: 7, key: "afraid", original: "끔찍한 일이 생길 것 같은 두려움", variants: [
    "뭔가 끔찍한 일이 일어날 것 같아 두려웠던 날이 있었어요?",
    "지난 2주 동안 불길한 예감에 두려움을 느낀 날은 어느 정도였나요?",
  ] },
];

export function interpretGAD7(total: number): { severity: string; text: string; recommend: boolean } {
  if (total <= 4) return { severity: "정상", text: "현재 불안 증상은 거의 없는 수준이에요.", recommend: false };
  if (total <= 9) return { severity: "가벼운 수준", text: "가벼운 불안감이 있어요. 휴식과 호흡 조절을 챙겨보세요.", recommend: false };
  if (total <= 14) return { severity: "중간 수준", text: "중간 정도의 불안 증상이 보여요. 전문가와 상담해 보시길 권해요.", recommend: true };
  return { severity: "심한 수준", text: "불안 증상이 심한 수준이에요. 꼭 전문가의 도움을 받아보세요.", recommend: true };
}

/** 척도 레지스트리 — mental-flow가 session.scale로 선택 */
export const SCALES: Record<string, { name: string; items: MentalItem[]; maxTotal: number; interpret: (t: number) => { severity: string; text: string; recommend: boolean } }> = {
  PHQ9: { name: "우울(PHQ-9)", items: PHQ9_ITEMS, maxTotal: 27, interpret: interpretPHQ9 },
  GAD7: { name: "불안(GAD-7)", items: GAD7_ITEMS, maxTotal: 21, interpret: interpretGAD7 },
};

/** 응답 안내 (재질문 시 함께 제시) */
export const ANSWER_GUIDE = "「전혀 없었다 / 며칠 정도 / 2주의 절반 이상 / 거의 매일」 중에 가까운 걸로 편하게 말씀해 주세요.";

/** PHQ-9 표준 컷오프 해석 */
export function interpretPHQ9(total: number): { severity: string; text: string; recommend: boolean } {
  if (total <= 4) return { severity: "정상", text: "현재 우울 증상은 거의 없는 수준이에요.", recommend: false };
  if (total <= 9) return { severity: "가벼운 수준", text: "가벼운 우울감이 있어요. 생활 리듬과 가벼운 활동을 챙겨보세요.", recommend: false };
  if (total <= 14) return { severity: "중간 수준", text: "중간 정도의 우울 증상이 보여요. 전문가와 상담해 보시길 권해요.", recommend: true };
  if (total <= 19) return { severity: "다소 심한 수준", text: "우울 증상이 다소 심한 편이에요. 가까운 시일 내 전문가 상담을 권해요.", recommend: true };
  return { severity: "심한 수준", text: "우울 증상이 심한 수준이에요. 꼭 전문가의 도움을 받아보세요.", recommend: true };
}

export const CRISIS_GUIDE = "많이 힘드셨겠어요. 혼자 견디지 마세요 — 자살예방 상담전화 109, 정신건강 위기상담 1577-0199(또는 1393)에서 24시간 이야기를 들어드려요. 가까운 분께도 꼭 알려주세요.";
export const NON_DIAGNOSTIC_NOTICE = "이 결과는 의학적 진단이 아닌 자가 점검이에요. 정확한 평가는 전문의와 상담해 주세요.";
