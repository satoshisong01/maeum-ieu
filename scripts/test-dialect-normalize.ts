// 사투리 → 표준어 정규화 검증
import { normalizeDialect, detectDialectRegions } from "../lib/chat/dialect-normalize";

interface Case { input: string; expected: string; label: string }

const cases: Case[] = [
  // ─── 경상 ────────────────────────────────────────────────
  { input: "어데 갔다 왔노?", expected: "어디 갔다 왔노?", label: "gs — 어데→어디" },
  { input: "쪼매 기다리소", expected: "조금 기다리소", label: "gs — 쪼매→조금" },
  { input: "마이 묵었다", expected: "많이 묵었다", label: "gs — 마이→많이" },
  { input: "그라이까 그래", expected: "그러니까 그래", label: "gs — 그라이까→그러니까" },
  { input: "할매가 부르더라", expected: "할머니가 부르더라", label: "gs — 할매→할머니" },

  // ─── 전라 ────────────────────────────────────────────────
  { input: "거시기 좀 갖다 줘", expected: "그거 좀 갖다 줘", label: "jl — 거시기→그거" },
  { input: "여그서 보자", expected: "여기서 보자", label: "jl — 여그→여기" },
  { input: "겁나 맛있다", expected: "엄청 맛있다", label: "jl — 겁나→엄청" },
  { input: "허벌나게 좋네", expected: "엄청 좋네", label: "jl — 허벌나게→엄청" },

  // ─── 충청 ────────────────────────────────────────────────
  { input: "그려유, 잘 되여", expected: "그래요, 잘 돼요", label: "cc — 그려유 + 되여" },
  { input: "내일 헐겨", expected: "내일 할 거야", label: "cc — 헐겨→할 거야" },

  // ─── 제주 ────────────────────────────────────────────────
  { input: "어디 감수꽈", expected: "어디 가세요", label: "jj — 감수꽈→가세요" },
  { input: "혼저옵서 환영합니다", expected: "어서 오세요 환영합니다", label: "jj — 혼저옵서→어서 오세요" },

  // ─── 공통 ────────────────────────────────────────────────
  { input: "에이고 깜짝이야", expected: "아이고 깜짝이야", label: "common — 에이고→아이고" },
  { input: "아부지가 오시면 말해", expected: "아버지가 오시면 말해", label: "common — 아부지→아버지" },

  // ─── 복수 매칭 (길이순 정렬 확인) ────────────────────────
  { input: "할매 어데 갔노", expected: "할머니 어디 갔노", label: "복수 — 할매 + 어데" },
  { input: "그라이까 거시기 좀 챙겨", expected: "그러니까 그거 좀 챙겨", label: "복수 — gs + jl 혼합" },

  // ─── 표준어 그대로 유지 ─────────────────────────────────
  { input: "안녕하세요 할아버지", expected: "안녕하세요 할아버지", label: "표준어 — 변경 없음" },
  { input: "점심 맛있게 먹었어요", expected: "점심 맛있게 먹었어요", label: "표준어 — 일반 발화" },

  // ─── 빈 입력 ─────────────────────────────────────────────
  { input: "", expected: "", label: "빈 입력 → noop" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = normalizeDialect(c.input);
  const ok = r.normalized === c.expected;
  if (ok) {
    const note = r.changes.length > 0 ? `  (${r.changes.length}건)` : "";
    console.log(`✓ ${c.label}${note}`);
    pass++;
  } else {
    console.log(`✗ ${c.label}`);
    console.log(`   in : "${c.input}"`);
    console.log(`   exp: "${c.expected}"`);
    console.log(`   got: "${r.normalized}"`);
    console.log(`   chg: ${JSON.stringify(r.changes)}`);
    fail++;
  }
}

// 지역 감지
console.log("\n--- detectDialectRegions ---");
const regionTests = [
  { input: "어데 갔노 할매야", expected: "gs" },
  { input: "거시기 여그 와", expected: "jl" },
  { input: "그려유 헐겨", expected: "cc" },
  { input: "감수꽈", expected: "jj" },
];
for (const t of regionTests) {
  const regions = detectDialectRegions(t.input);
  const ok = regions.has(t.expected as "gs" | "jl" | "jj" | "cc" | "common");
  if (ok) { console.log(`✓ region "${t.input}" → has ${t.expected}`); pass++; }
  else { console.log(`✗ region "${t.input}" → expected ${t.expected}, got [${Array.from(regions).join(",")}]`); fail++; }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
