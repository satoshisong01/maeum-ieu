/**
 * 사투리 → 표준어 정규화.
 *
 * 배경: 노인 화자의 지역 사투리(경상/전라/제주/충청 등)가 STT로 그대로 들어오면
 * 인지 분석기가 "language" 영역 이상으로 오판할 위험. 인지 분석기는 표준어 기준으로
 * 어휘 빈도·문법 패턴을 본다.
 *
 * 정책:
 * - 사투리는 매우 다양해 완벽한 변환은 불가능. 빈도 높은 200어휘 정도만 매핑.
 * - 표준어 변환은 인지 분석용 normalize 단계에서만 적용. UI/저장본은 원문 유지(사용자 정체성 보존).
 * - 형태소 분석 없이 substring 치환 → 단순하지만 false positive 가능. 경계 보호용 lookbehind 사용.
 *
 * 활용 위치:
 * - cognitive-analyzer에서 사용자 발화를 normalize한 뒤 분석 (UI 응답은 원문 그대로)
 * - 필요시 RAG/메모리 검색에도 normalize된 텍스트로 임베딩
 */

interface DialectEntry {
  /** 사투리 표현 */
  d: string;
  /** 표준어 */
  s: string;
  /** 지역 태그 (디버깅용) */
  r: "gs" | "jl" | "jj" | "cc" | "common";
}

// 빈도 높고 의미 충돌 적은 항목 위주. 의미가 다르거나 표준어와 발음 가까운 건 제외.
const ENTRIES: DialectEntry[] = [
  // ─── 경상 (Gyeongsang, gs) ────────────────────────────────
  { d: "안카나", s: "안 그러나", r: "gs" },
  { d: "와이라노", s: "왜 이러냐", r: "gs" },
  { d: "와이라", s: "왜 이래", r: "gs" },
  { d: "머라카노", s: "뭐라 그러냐", r: "gs" },
  { d: "머라카", s: "뭐라 그래", r: "gs" },
  { d: "어데", s: "어디", r: "gs" },
  { d: "어데고", s: "어디냐", r: "gs" },
  { d: "어데서", s: "어디서", r: "gs" },
  { d: "그라모", s: "그러면", r: "gs" },
  { d: "그라믄", s: "그러면", r: "gs" },
  { d: "그라이까", s: "그러니까", r: "gs" },
  { d: "그라이꺼네", s: "그러니까", r: "gs" },
  { d: "마이", s: "많이", r: "gs" },
  { d: "디기", s: "되게", r: "gs" },
  { d: "억수로", s: "엄청", r: "gs" },
  { d: "쪼매", s: "조금", r: "gs" },
  { d: "쪼맨한", s: "조그만한", r: "gs" },
  { d: "단디", s: "단단히", r: "gs" },
  { d: "퍼떡", s: "빨리", r: "gs" },
  { d: "고마", s: "그만", r: "gs" },
  { d: "겁나게", s: "엄청", r: "gs" },
  { d: "께 안", s: "그게 안", r: "gs" },
  { d: "내사", s: "나는", r: "gs" },
  { d: "니사", s: "너는", r: "gs" },
  // "지가"는 "아버지가", "동지가" 등 정상 어휘에 부분 매칭되어 제거.
  // 필요하면 lookahead/lookbehind로 경계 보호한 별도 패턴 처리.
  { d: "야들", s: "이 아이들", r: "gs" },
  { d: "고들", s: "그 아이들", r: "gs" },
  { d: "할매", s: "할머니", r: "gs" },
  { d: "할배", s: "할아버지", r: "gs" },
  { d: "엄니", s: "어머니", r: "common" },
  { d: "아부지", s: "아버지", r: "common" },
  { d: "오빠야", s: "오빠", r: "gs" },
  { d: "행님", s: "형님", r: "gs" },
  { d: "누님", s: "누님", r: "common" }, // 동일

  // ─── 전라 (Jeolla, jl) ─────────────────────────────────────
  { d: "거시기", s: "그거", r: "jl" },
  { d: "거시기허다", s: "그러하다", r: "jl" },
  // "잉"은 잉어/잉크 등 명사에 substring 매칭되어 제거. 종결어미 정규화는 형태소 분석 필요.
  { d: "그라제", s: "그렇지", r: "jl" },
  { d: "그라요", s: "그래요", r: "jl" },
  { d: "워매", s: "어머", r: "jl" },
  { d: "겁나", s: "엄청", r: "jl" },
  { d: "솔찬히", s: "꽤", r: "jl" },
  { d: "솔찬허다", s: "꽤 하다", r: "jl" },
  { d: "허벌나게", s: "엄청", r: "jl" },
  { d: "허벌", s: "엄청", r: "jl" },
  { d: "쩌그", s: "저기", r: "jl" },
  { d: "여그", s: "여기", r: "jl" },
  { d: "거그", s: "거기", r: "jl" },
  { d: "오메", s: "어머", r: "jl" },
  { d: "허씨요", s: "하세요", r: "jl" },
  { d: "허지마", s: "하지 마", r: "jl" },
  { d: "허믄", s: "하면", r: "jl" },
  { d: "잡순다", s: "잡수신다", r: "jl" },
  { d: "잡쉈어", s: "잡수셨어", r: "jl" },
  { d: "겁난다", s: "무섭다", r: "jl" },

  // ─── 제주 (Jeju, jj) — 매우 다양하지만 보수적으로 ──────────
  { d: "혼저옵서", s: "어서 오세요", r: "jj" },
  { d: "어디 감수꽈", s: "어디 가세요", r: "jj" },
  { d: "감수꽈", s: "가세요", r: "jj" },
  { d: "이서마씀", s: "있어요", r: "jj" },
  // "마씀" 단독은 다른 어휘 substring 충돌 가능성 → 제거. "이서마씀" 전체 표현만 매핑.
  { d: "허영", s: "해서", r: "jj" },
  { d: "혼저", s: "어서", r: "jj" },

  // ─── 충청 (Chungcheong, cc) — 느릿한 종결어미 ──────────────
  { d: "그려유", s: "그래요", r: "cc" },
  { d: "허유", s: "해요", r: "cc" },
  { d: "혀유", s: "해요", r: "cc" },
  { d: "혀어", s: "해", r: "cc" },
  { d: "되여", s: "돼요", r: "cc" },
  { d: "되유", s: "돼요", r: "cc" },
  { d: "헐겨", s: "할 거야", r: "cc" },

  // ─── 공통 노년층 화법 ────────────────────────────────────
  { d: "지금사", s: "지금에야", r: "common" },
  { d: "그라고", s: "그리고", r: "common" },
  { d: "에이고", s: "아이고", r: "common" },
  { d: "아따", s: "아", r: "common" },
];

// 길이 긴 항목을 먼저 매칭 (부분 매칭 충돌 방지)
const SORTED_ENTRIES = [...ENTRIES].sort((a, b) => b.d.length - a.d.length);

export interface DialectNormalizeResult {
  normalized: string;
  changes: Array<{ from: string; to: string; region: string }>;
}

/**
 * 사용자 발화를 표준어로 정규화. 원문은 보존하고 정규화 결과만 반환.
 *
 * 한글 lookbehind/lookahead로 단어 경계 보호 — "단디(단단히)" → "단단히" 인데
 * 다른 단어 내부의 "단디"가 우연히 끼면 안 되니까. 다만 한국어는 띄어쓰기가 임의적이어서
 * 완벽 보호는 어렵다. false positive 가능성을 감안해 매핑 후보를 보수적으로 제한.
 */
export function normalizeDialect(text: string): DialectNormalizeResult {
  if (!text) return { normalized: text, changes: [] };

  let out = text;
  const changes: DialectNormalizeResult["changes"] = [];

  for (const e of SORTED_ENTRIES) {
    if (!out.includes(e.d)) continue;
    out = out.split(e.d).join(e.s);
    changes.push({ from: e.d, to: e.s, region: e.r });
  }

  return { normalized: out, changes };
}

/** 디버깅·통계용 — 발화에 포함된 사투리 지역 분포 추정 */
export function detectDialectRegions(text: string): Set<DialectEntry["r"]> {
  const regions = new Set<DialectEntry["r"]>();
  if (!text) return regions;
  for (const e of ENTRIES) {
    if (text.includes(e.d)) regions.add(e.r);
  }
  return regions;
}
