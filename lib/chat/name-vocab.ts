/**
 * 이름으로 오인되는 추상명사/일반명사 통합 목록 — name stopword 단일 소스.
 *
 * 이전엔 3개 파일에 3벌 유지되어("동기화 필요" 주석) 누수/회귀 위험이 있었음:
 *   - profile-extractor.ts     STOPWORD_NAME          = BASE + ABSTRACT + 파일 전용(민지/오늘/의문형 등)
 *   - profile-extractor-llm.ts ABSTRACT_NOUN_BLOCKLIST = BASE + ABSTRACT (정확히 이 합집합)
 *   - fact-checker.ts          NAME_STOPWORDS          = BASE + 파일 전용(가족 호칭/대명사/조사 잔여)
 *
 * ⚠ 의미 주의 — ABSTRACT_NOUN_BLOCKLIST는 fact-checker에 합치면 안 됨:
 *   extractor 계열에서 stopword = "이름으로 저장 금지"(클수록 안전)지만,
 *   fact-checker에서 stopword = "grounding 검증 면제"(클수록 위험).
 *   "재미" 환각(2026-05-26 사고)은 fact-checker가 검증 대상으로 잡아야 문장이 제거됨.
 */

/** 3개 소비자 모두 공통인 안전 코어 — 명백히 사람 이름이 아닌 호칭·일반 명사. */
export const NAME_STOPWORDS_BASE: readonly string[] = [
  "할아버지", "할머니", "선생님", "회원님", "고객님", "어르신", "아드님", "따님",
  "기억",
];

/**
 * 추상 명사·일반 단어 — 사람 이름으로 절대 박혀서는 안 되는 어휘
 * (2026-05-26 "재미" 누수 사고 root cause). profile-extractor + profile-extractor-llm 전용.
 */
export const ABSTRACT_NOUN_BLOCKLIST: readonly string[] = [
  "재미", "취미", "행복", "사랑", "마음", "생각", "이야기", "추억", "시간", "진심", "정성", "복덩이",
  "효자", "효녀", "걱정", "근심", "고민", "기쁨", "슬픔", "외로움", "그리움", "고마움", "감사",
  "정", "사정", "사연", "이유", "건강", "기억", "다행", "축복", "복", "꿈", "희망", "용기", "위로",
];
