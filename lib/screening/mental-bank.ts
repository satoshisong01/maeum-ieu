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
  /** 역채점 문항 (BFI-10 등) — 분류 점수를 (max - score)로 뒤집어 저장 */
  reverse?: boolean;
}

/** 응답 형식 — 척도별 분류기·안내문 선택 */
export type AnswerType = "freq4" | "agree5" | "freq3";

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

/**
 * UCLA-3 외로움 (3문항 단축형, Hughes et al. 2004) — 1~3점 매핑(거의 없다1/가끔2/자주3), 합계 3~9.
 * 통용 컷오프: 6점 이상 = 외로움 높음.
 */
export const UCLA3_ITEMS: MentalItem[] = [
  { no: 1, key: "companionship", original: "어울릴 사람이 없다고 느낌", variants: [
    "요즘, 같이 어울릴 사람이 없다고 느끼시는 일이 얼마나 자주 있어요?",
    "함께 시간을 보낼 사람이 부족하다고 느끼는 때가 자주 있으신가요?",
  ] },
  { no: 2, key: "leftout", original: "소외감을 느낌", variants: [
    "주변에서 나만 빠져 있는 것 같은, 소외된 느낌이 드는 일은 얼마나 자주 있어요?",
    "사람들 사이에서 겉도는 느낌이 드는 때가 자주 있으신가요?",
  ] },
  { no: 3, key: "isolated", original: "다른 사람들로부터 고립되어 있다고 느낌", variants: [
    "다른 사람들과 떨어져 혼자라고 느끼는 일은 얼마나 자주 있으세요?",
    "세상과 단절된 것처럼 외롭다고 느끼는 때가 자주 있으신가요?",
  ] },
];

export function interpretUCLA3(total: number): { severity: string; text: string; recommend: boolean } {
  if (total <= 5) return { severity: "정상", text: "외로움은 낮은 수준이에요. 지금처럼 교류를 이어가세요.", recommend: false };
  if (total <= 7) return { severity: "다소 높음", text: "외로움을 자주 느끼고 계세요. 가까운 분과의 만남이나 모임 참여를 늘려보세요.", recommend: false };
  return { severity: "높음", text: "외로움이 높은 수준이에요. 가족·복지관·상담 등 연결될 수 있는 곳을 함께 찾아봐요.", recommend: true };
}

/**
 * BFI-10 성격 5요인 (Rammstedt & John 2007, 단축형) — 0~4점 동의 척도, 절반 역채점.
 * 요인당 2문항(0~8점): 외향성E·친화성A·성실성C·신경성N·개방성O. 결과는 등급이 아닌 프로파일.
 * ⚠ 라이선스: 연구용 무료 공개 — 상용 서비스 정식 출시 전 사용 허가 확인 필요(문항 출처 명시).
 */
export const BFI10_ITEMS: MentalItem[] = [
  { no: 1, key: "E_r", original: "나는 말수가 적고 내성적이다 (외향성 역문항)", reverse: true, variants: [
    "평소 나는 말수가 적고 조용한 편이다 — 어느 정도 그렇다고 보세요?",
    "사람들 앞에서 나서기보다 조용히 있는 편이다 — 본인과 얼마나 맞는 말인가요?",
  ] },
  { no: 2, key: "A", original: "나는 대체로 다른 사람을 믿는다", variants: [
    "나는 다른 사람을 잘 믿는 편이다 — 어느 정도 그러세요?",
    "처음 만난 사람도 일단 믿고 보는 편이다 — 본인과 얼마나 맞나요?",
  ] },
  { no: 3, key: "C_r", original: "나는 게으른 편이다 (성실성 역문항)", reverse: true, variants: [
    "솔직히 나는 게으른 편이다 — 어느 정도 그렇다고 보세요?",
    "할 일을 미루고 늘어지는 편이다 — 본인과 얼마나 맞는 말인가요?",
  ] },
  { no: 4, key: "N_r", original: "나는 느긋하고 스트레스를 잘 다룬다 (신경성 역문항)", reverse: true, variants: [
    "나는 느긋한 편이고 스트레스를 잘 견딘다 — 어느 정도 그러세요?",
    "웬만한 일에는 마음이 크게 흔들리지 않는다 — 본인과 얼마나 맞나요?",
  ] },
  { no: 5, key: "O_r", original: "나는 예술적 관심이 거의 없다 (개방성 역문항)", reverse: true, variants: [
    "그림·음악 같은 예술에는 별로 관심이 없는 편이다 — 어느 정도 그러세요?",
    "예술 쪽 일에는 흥미가 잘 안 생긴다 — 본인과 얼마나 맞는 말인가요?",
  ] },
  { no: 6, key: "E", original: "나는 외향적이고 사교적이다", variants: [
    "나는 사교적이고 활달한 편이다 — 어느 정도 그러세요?",
    "사람들과 어울리는 자리가 즐겁고 기운이 난다 — 본인과 얼마나 맞나요?",
  ] },
  { no: 7, key: "A_r", original: "나는 남의 흠을 잘 찾는 편이다 (친화성 역문항)", reverse: true, variants: [
    "나는 다른 사람의 단점이 먼저 눈에 들어오는 편이다 — 어느 정도 그러세요?",
    "남의 흠을 잘 집어내는 편이다 — 본인과 얼마나 맞는 말인가요?",
  ] },
  { no: 8, key: "C", original: "나는 일을 철저히 한다", variants: [
    "나는 맡은 일을 꼼꼼하고 철저하게 하는 편이다 — 어느 정도 그러세요?",
    "일을 하면 끝까지 마무리해야 마음이 놓인다 — 본인과 얼마나 맞나요?",
  ] },
  { no: 9, key: "N", original: "나는 쉽게 불안해진다", variants: [
    "나는 사소한 일에도 쉽게 불안해지는 편이다 — 어느 정도 그러세요?",
    "걱정이 많고 마음이 자주 조마조마하다 — 본인과 얼마나 맞는 말인가요?",
  ] },
  { no: 10, key: "O", original: "나는 상상력이 풍부하다", variants: [
    "나는 상상력이 풍부한 편이다 — 어느 정도 그러세요?",
    "새로운 생각이나 공상을 즐기는 편이다 — 본인과 얼마나 맞나요?",
  ] },
];

const BFI_DIMS: Record<string, { label: string; lo: string; hi: string }> = {
  E: { label: "외향성", lo: "차분·내향형", hi: "사교·활동형" },
  A: { label: "친화성", lo: "독립·비판형", hi: "신뢰·온화형" },
  C: { label: "성실성", lo: "자유·즉흥형", hi: "계획·꼼꼼형" },
  N: { label: "정서 민감성", lo: "안정형", hi: "민감형" },
  O: { label: "개방성", lo: "현실·실용형", hi: "호기심·상상형" },
};

/**
 * BFI-10 프로파일 해석 — 문항별 점수(역채점 반영된 값)에서 요인별 0~8점 프로파일 생성.
 * 성격엔 정상/이상이 없음 — severity는 항상 "프로파일", recommend 없음.
 */
export function interpretBFI10Profile(scores: { itemNo: number; score: number }[]): { severity: string; text: string; recommend: boolean } {
  const byKey: Record<string, number> = {};
  for (const s of scores) {
    const item = BFI10_ITEMS[s.itemNo - 1];
    if (!item) continue;
    const dim = item.key.replace("_r", "");
    byKey[dim] = (byKey[dim] ?? 0) + s.score;
  }
  const parts = Object.entries(BFI_DIMS).map(([dim, meta]) => {
    const v = byKey[dim] ?? 0;
    const band = v <= 2 ? meta.lo : v <= 5 ? "중간" : meta.hi;
    return `${meta.label} ${v}/8(${band})`;
  });
  return { severity: "프로파일", text: `성격 5요인 — ${parts.join(" · ")}`, recommend: false };
}

/** 척도 레지스트리 — mental-flow가 session.scale로 선택 */
export interface ScaleDef {
  name: string;
  items: MentalItem[];
  maxTotal: number;
  answerType: AnswerType;
  /** 응답 안내 (동의·재질문 시 제시) */
  answerGuide: string;
  interpret: (t: number) => { severity: string; text: string; recommend: boolean };
  /** 문항별 점수 기반 해석 (BFI-10 프로파일 등) — 있으면 interpret 대신 사용 */
  interpretItems?: (scores: { itemNo: number; score: number }[]) => { severity: string; text: string; recommend: boolean };
}

export const AGREE_GUIDE = "「전혀 아니다 / 아닌 편이다 / 보통이다 / 그런 편이다 / 매우 그렇다」 중에 가까운 걸로 편하게 말씀해 주세요.";
export const FREQ3_GUIDE = "「거의 없다 / 가끔 그렇다 / 자주 그렇다」 중에 가까운 걸로 편하게 말씀해 주세요.";

export const SCALES: Record<string, ScaleDef> = {
  PHQ9: { name: "우울(PHQ-9)", items: PHQ9_ITEMS, maxTotal: 27, answerType: "freq4", answerGuide: "「전혀 없었다 / 며칠 정도 / 2주의 절반 이상 / 거의 매일」 중에 가까운 걸로 편하게 말씀해 주세요.", interpret: interpretPHQ9 },
  GAD7: { name: "불안(GAD-7)", items: GAD7_ITEMS, maxTotal: 21, answerType: "freq4", answerGuide: "「전혀 없었다 / 며칠 정도 / 2주의 절반 이상 / 거의 매일」 중에 가까운 걸로 편하게 말씀해 주세요.", interpret: interpretGAD7 },
  UCLA3: { name: "외로움(UCLA-3)", items: UCLA3_ITEMS, maxTotal: 9, answerType: "freq3", answerGuide: FREQ3_GUIDE, interpret: interpretUCLA3 },
  BFI10: { name: "성격 5요인(BFI-10)", items: BFI10_ITEMS, maxTotal: 40, answerType: "agree5", answerGuide: AGREE_GUIDE, interpret: () => ({ severity: "프로파일", text: "", recommend: false }), interpretItems: interpretBFI10Profile },
};

/** 응답 안내 (freq4 기본 — 기존 호출부 호환) */
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
