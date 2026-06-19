/**
 * 전문가 검진 표준 인지선별 문항 뱅크 — CIST·MMSE-K/MoCA-K 기준의 단일 출처.
 * 용도: (1) 전문가 질문지 미리보기(/expert/protocol), (2) 검진 가이드(proGuideBlock) 렌더,
 *       (3) Phase 2 항목별 채점(item-level 30점) 기반.
 * 음성 검진 한계: 시공간(시계 그리기·도형)은 voice=false — 음성 미시행, 화면·지필 검사 시에만.
 */

export interface CistItem {
  id: string;
  domain: string;        // cognitive_assessments 영역 키와 일치
  domainLabel: string;
  source: string;        // 근거 도구
  prompt: string;        // 검사자가 읽는 문항
  points: number;        // 항목 배점
  scoring: string;       // 채점 기준(전문가 확인 + Phase 2 채점용)
  voice: boolean;        // 음성으로 시행 가능한가
}

export const CIST_ITEMS: CistItem[] = [
  // 시간 지남력 (5점)
  { id: "ot_year", domain: "orientation_time", domainLabel: "시간 지남력", source: "MMSE-K/CIST", prompt: "올해는 몇 년도입니까?", points: 1, scoring: "정확한 연도 1점", voice: true },
  { id: "ot_season", domain: "orientation_time", domainLabel: "시간 지남력", source: "MMSE-K", prompt: "지금은 무슨 계절입니까?", points: 1, scoring: "현재 계절(환절기 ±1 인정) 1점", voice: true },
  { id: "ot_month", domain: "orientation_time", domainLabel: "시간 지남력", source: "MMSE-K/CIST", prompt: "오늘은 몇 월입니까?", points: 1, scoring: "정확한 월 1점", voice: true },
  { id: "ot_day", domain: "orientation_time", domainLabel: "시간 지남력", source: "MMSE-K/CIST", prompt: "오늘은 며칠입니까?", points: 1, scoring: "±1일 인정 1점", voice: true },
  { id: "ot_weekday", domain: "orientation_time", domainLabel: "시간 지남력", source: "MMSE-K/CIST", prompt: "오늘은 무슨 요일입니까?", points: 1, scoring: "정확한 요일 1점", voice: true },
  // 장소 지남력 (5점)
  { id: "op_sido", domain: "orientation_place", domainLabel: "장소 지남력", source: "MMSE-K", prompt: "지금 계신 곳은 무슨 시·도입니까?", points: 1, scoring: "정확 1점", voice: true },
  { id: "op_sigungu", domain: "orientation_place", domainLabel: "장소 지남력", source: "MMSE-K", prompt: "무슨 시·군·구입니까?", points: 1, scoring: "정확 1점", voice: true },
  { id: "op_dong", domain: "orientation_place", domainLabel: "장소 지남력", source: "MMSE-K", prompt: "무슨 동·읍·면입니까?", points: 1, scoring: "정확 1점", voice: true },
  { id: "op_kind", domain: "orientation_place", domainLabel: "장소 지남력", source: "MMSE-K/CIST", prompt: "여기는 어떤 곳입니까? (집·병원·기관 등)", points: 1, scoring: "장소 유형 정확 1점", voice: true },
  { id: "op_floor", domain: "orientation_place", domainLabel: "장소 지남력", source: "MMSE-K", prompt: "지금 몇 층에 계십니까?", points: 1, scoring: "정확 1점", voice: true },
  // 즉시 기억(등록) (3점)
  { id: "mi_words", domain: "memory_immediate", domainLabel: "즉시 기억(등록)", source: "MMSE-K/CIST", prompt: "단어 세 개를 불러드릴게요. 따라 말한 뒤 기억해 두세요 — ‘나무, 자동차, 모자’.", points: 3, scoring: "즉시 따라 말한 단어당 1점(최대 3). 못 외우면 최대 1회 더 들려주되 채점은 1차 기준.", voice: true },
  // 주의·계산 (5점)
  { id: "ac_serial7", domain: "attention_calculation", domainLabel: "주의·계산", source: "MMSE-K", prompt: "100에서 7을 빼면? 거기서 또 7씩 다섯 번 빼 주세요. (93·86·79·72·65)", points: 5, scoring: "정답 단계당 1점(최대 5). 앞 답이 틀려도 그 값에서 -7 맞으면 인정.", voice: true },
  { id: "ac_digitspan", domain: "attention_calculation", domainLabel: "주의·계산", source: "MoCA-K/CIST", prompt: "제가 부르는 숫자를 거꾸로 말해 보세요 — ‘5-2-9’, 다음 ‘3-7-1-6’.", points: 0, scoring: "보조 문항(연속빼기 곤란 시 대체). 거꾸로 정확 시 주의력 양호 참고.", voice: true },
  // 지연 기억(회상) (3점)
  { id: "md_recall", domain: "memory_delayed", domainLabel: "지연 기억(회상)", source: "MMSE-K/CIST", prompt: "아까 외워 두시라고 한 단어 세 개가 무엇이었습니까?", points: 3, scoring: "자발 회상 단어당 1점(최대 3). 힌트·정답 비노출.", voice: true },
  // 언어 (5점)
  { id: "lg_repeat", domain: "language", domainLabel: "언어", source: "MMSE-K", prompt: "제가 말하는 문장을 그대로 따라 해 보세요 — ‘백문이 불여일견’.", points: 1, scoring: "정확히 따라 하면 1점", voice: true },
  { id: "lg_naming", domain: "language", domainLabel: "언어", source: "MMSE-K/CIST", prompt: "설명을 듣고 이름을 말해 보세요 — ‘손목에 차고 시간 보는 물건’? ‘글씨 쓰는 도구’?", points: 2, scoring: "맞힌 물건당 1점(시계·연필, 최대 2)", voice: true },
  { id: "lg_fluency", domain: "language", domainLabel: "언어", source: "MoCA-K", prompt: "1분 동안 생각나는 동물 이름을 최대한 많이 말씀해 보세요.", points: 2, scoring: "1분 ≥14개 2점 / 9~13개 1점 / 8개 이하 0점(의미 유창성)", voice: true },
  // 판단·집행 (3점)
  { id: "jd_similarity", domain: "judgment", domainLabel: "판단·집행", source: "MoCA-K", prompt: "기차와 자전거의 공통점은 무엇입니까? (또는 사과와 바나나)", points: 2, scoring: "상위 범주 추상 2점 / 구체적 공통점 1점 / 무관 0점", voice: true },
  { id: "jd_social", domain: "judgment", domainLabel: "판단·집행", source: "MMSE-K/CDR", prompt: "길에서 다른 사람의 주민등록증을 주우면 어떻게 하시겠습니까?", points: 1, scoring: "사회적으로 적절한 처리(주인·기관 전달) 1점", voice: true },
  // 시공간 (음성 미시행)
  { id: "vs_clock", domain: "visuospatial", domainLabel: "시공간(구성)", source: "MoCA-K/CIST", prompt: "시계를 그리고 ‘11시 10분’을 표시해 보세요. (또는 겹친 도형 따라 그리기)", points: 2, scoring: "윤곽·숫자·바늘 위치 정확도. ⚠ 음성만으로는 시행 불가 — 화면·지필 검사 시에만.", voice: false },
];

/** 항목 ID → 짧은 한글 이름(전문가 화면 표시용 — 변수명 대신 사람이 읽을 라벨). */
export const CIST_ITEM_LABELS: Record<string, string> = {
  ot_year: "연도", ot_season: "계절", ot_month: "월", ot_day: "날짜", ot_weekday: "요일",
  op_sido: "광역 지역(시·도)", op_sigungu: "시·군·구", op_dong: "동네(동·읍·면)", op_kind: "장소 종류", op_floor: "층수",
  mi_words: "단어 등록", ac_serial7: "연속 빼기", ac_digitspan: "숫자 거꾸로",
  md_recall: "단어 회상(지연)", lg_repeat: "문장 따라하기", lg_naming: "이름 대기", lg_fluency: "동물 말하기",
  jd_similarity: "공통점 찾기", jd_social: "상황 판단", vs_clock: "시계 그리기",
};
export function itemLabel(id: string): string { return CIST_ITEM_LABELS[id] ?? id; }

export const CIST_DOMAIN_ORDER: { domain: string; label: string }[] = [
  { domain: "orientation_time", label: "시간 지남력" },
  { domain: "orientation_place", label: "장소 지남력" },
  { domain: "memory_immediate", label: "즉시 기억(등록)" },
  { domain: "attention_calculation", label: "주의·계산" },
  { domain: "memory_delayed", label: "지연 기억(회상)" },
  { domain: "language", label: "언어" },
  { domain: "judgment", label: "판단·집행" },
  { domain: "visuospatial", label: "시공간(구성)" },
];

/** 음성 시행 가능 항목의 총 배점(시공간 제외) — 환산 만점 기준. */
export const VOICE_MAX_POINTS = CIST_ITEMS.filter((i) => i.voice).reduce((s, i) => s + i.points, 0);

// ── 검진 순서 변형 — 매 검진(월/분기)마다 순서를 조금씩 다르게(시드 기반). ──
//   타당성 제약: 즉시기억(등록)은 지연회상보다 먼저 + 그 사이 최소 2개 영역(지연 효과 확보).
//   시공간은 음성 미시행이라 순서에서 제외.
// 메모리 외 영역 — 자유 셔플. memory_immediate/memory_delayed는 제약에 맞춰 따로 삽입.
const EXAM_FREE_DOMAINS = ["orientation_time", "orientation_place", "attention_calculation", "language", "judgment"];

function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return h >>> 0;
}
function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * 검진 영역 시행 순서 — 시드(예: 대화ID+날짜)로 매 검진 다르게. 같은 검진 내에선 동일(안정).
 * 타당성 제약: memory_immediate(등록)는 앞쪽에, memory_delayed(지연회상)는 그 뒤 +2 이상(지연 효과 유지).
 */
export function buildExamOrder(seed: string): string[] {
  const rnd = mulberry32(hashSeed(seed));
  const others = [...EXAM_FREE_DOMAINS]; // 5개
  for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
  // 즉시기억은 앞쪽(0~2)에 삽입 → 뒤에 지연회상을 +2 이상 둘 공간 확보
  const miPos = Math.floor(rnd() * 3); // 0,1,2
  const withMi = [...others];
  withMi.splice(miPos, 0, "memory_immediate"); // 길이 6
  // 지연회상은 miPos+2 ~ 끝 사이
  const minMd = miPos + 2;
  const mdPos = minMd + Math.floor(rnd() * (withMi.length + 1 - minMd));
  const order = [...withMi];
  order.splice(mdPos, 0, "memory_delayed"); // 길이 7
  return order;
}

/** 검진 가이드(proGuideBlock)용 — 음성 시행 영역의 문항을 영역별로 묶어 텍스트로 렌더(단일 출처). */
export function renderProtocolForGuide(): string {
  const lines: string[] = [];
  for (const { domain, label } of CIST_DOMAIN_ORDER) {
    if (domain === "visuospatial") continue; // 음성 미시행
    const items = CIST_ITEMS.filter((i) => i.domain === domain && i.voice);
    if (items.length === 0) continue;
    lines.push(`- ${label}: ${items.map((i) => `“${i.prompt}”`).join(" ")}`);
  }
  return lines.join("\n");
}
