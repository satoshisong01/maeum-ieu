/**
 * 확인 턴 라우팅 회귀 — "채점 결정적 턴"이 저가 모델·lite 분석기로 조용히 새는 경로를 고정한다.
 *
 * 성격: 단위 테스트(buildSystemPrompt의 DB·질문풀 의존성을 스텁)
 *
 * 왜 필요한가: probeTurn은 두 가지를 동시에 지배한다 — (1) 동반자 모델 선택(2.5 ↔ 3.8-flash),
 *   (2) 분석기 2단 라우팅(lite 1차 ↔ primary 직행). 그래서 이 플래그가 false로 새면
 *   **아무 에러 없이 선별 품질만 떨어진다**(2026-09-30 실측: 모델을 내리면 확인턴 지시 준수가
 *   깨져 인지 선별이 소리 없이 멈춤). 로그에도 흔적이 남지 않아 사람이 알아챌 방법이 없다.
 *   2026-10-02에 pro 모드가 바로 이 상태였다 — 의사가 시행해 결과지에 올라가는 경로인데
 *   표준 문항 7개 규칙을 2.5-flash가 받고 있었다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  user: { findUnique: vi.fn() },
  message: { count: vi.fn(), findFirst: vi.fn(async () => null) },
  // getTodayAssessedDomains — 빈 배열 = 오늘 평가된 영역 없음(= 검사 진행 중, remaining > 0)
  $queryRawUnsafe: vi.fn(async () => []),
};
vi.mock("@/lib/prisma", () => ({ prisma: db }));

vi.mock("@/lib/health/cognitive-level", () => ({
  getCognitiveTierForPrompt: vi.fn(async () => ({ tier: "평가전", avg: -1 })),
  buildCognitiveAdaptationHint: vi.fn(() => ""),
  getWeakDomainsForPrompt: vi.fn(async () => []),
}));
vi.mock("@/lib/chat/profile", () => ({
  getFullProfile: vi.fn(async () => ({ profile: null, family: [], facts: [] })),
  renderProfileForPrompt: vi.fn(() => ""),
}));
vi.mock("@/lib/chat/summarizer", () => ({
  getRecentSummaries: vi.fn(async () => []),
  renderSummariesForPrompt: vi.fn(() => ""),
}));
vi.mock("@/lib/screening/question-bank", () => ({
  isBankReady: vi.fn(() => true),
  sampleQuestionsForDomain: vi.fn(() => [{ text: "요즘 뭐 하고 지내세요?" }]),
}));

const TIME = { dateStr: "2026년 10월 2일 금요일 오후 3시", timeLabel: "오후", isoDate: "2026-10-02" };
const WEATHER = { promptText: "맑음" };

async function build(mode: "user" | "pro" | "general", userMsgCount = 0) {
  db.message.count.mockResolvedValue(userMsgCount);
  const mod = await import("@/lib/chat/prompt");
  return mod.buildSystemPrompt({
    userId: "u1", conversationId: "c1",
    timeCtx: TIME as never, weather: WEATHER as never, mode,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.message.findFirst.mockResolvedValue(null);
  db.$queryRawUnsafe.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({
    name: "김검사", age: 78, gender: "female",
    companionName: "민지", companionRelation: "손녀", userHonorific: null,
  });
});

describe("pro 모드 — 표준화 검사 시행은 항상 채점 결정적", () => {
  it("probeTurn이 켜진다 (모델 상향 + 분석기 primary 직행)", async () => {
    const r = await build("pro");
    // 🔒 false면 buildProGuideBlock의 7개 엄수 규칙이 2.5-flash로 내려간다
    expect(r.probeTurn).toBe(true);
  });

  it("prevProbeTurn도 켜진다 — pro의 모든 사용자 발화는 출제된 과제의 답변", async () => {
    const r = await build("pro");
    expect(r.prevProbeTurn).toBe(true);
  });

  it("검사 시행 지시문이 실제로 들어간다 (분기 자체가 살아있는지)", async () => {
    const r = await build("pro");
    expect(r.turnBlock).toContain("검사 시행 모드");
  });
});

describe("사용자 모드 — 5턴 주기 유지(회귀 방지)", () => {
  it("수다 턴(1번째)은 probeTurn이 꺼져 있다", async () => {
    const r = await build("user", 0);   // userTurnIndex = 1
    expect(r.probeTurn).toBe(false);
  });

  it("3번째 턴은 확인 턴", async () => {
    const r = await build("user", 2);   // userTurnIndex = 3
    expect(r.probeTurn).toBe(true);
  });

  it("4번째 턴은 직전 확인 턴의 답변 — prevProbeTurn", async () => {
    const r = await build("user", 3);   // userTurnIndex = 4
    expect(r.probeTurn).toBe(false);
    expect(r.prevProbeTurn).toBe(true);
  });
});

describe("일반인 모드 — 인지 선별 없음", () => {
  it("probeTurn·prevProbeTurn 모두 꺼져 있다", async () => {
    const r = await build("general");
    expect(r.probeTurn).toBe(false);
    expect(r.prevProbeTurn).toBe(false);
  });
});

/**
 * 죽은 분석기 탐지 — 실패를 "이상 없음"과 구별할 수 있는가.
 *
 * 이전엔 실패 경로가 모두 `cognitiveChecks: []`만 돌려줘서, 로그상 "분석기가 죽었다"와
 * "건드린 영역이 없는 평범한 수다 턴"이 완전히 같은 모양이었다. 선별이 멈춘 걸
 * 운영자가 알아챌 신호가 0이었다는 뜻이다.
 */
describe("분석 실패는 '이상 없음'과 구별된다", () => {
  it("API 키가 없으면 degraded 사유를 달아 돌려준다", async () => {
    vi.resetModules();
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { analyzeCognitive } = await import("@/lib/chat/cognitive-analyzer");
      const r = await analyzeCognitive({
        userMessage: "오늘이 며칠인지 모르겠네", assistantResponse: "괜찮습니다",
        historyText: "", envBlock: "",
      });
      // 🔒 degraded가 비면 운영자는 이 턴이 채점된 줄 안다
      expect(r.degraded).toBe("no-api-key");
      expect(r.cognitiveChecks).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});

/**
 * 체인의 **마지막 링크** — probeTurn(boolean)이 실제 모델명으로 이어지는가.
 *
 * 2026-10-02 적대 리뷰 지적: 위 테스트들은 probeTurn이 true/false인지까지만 본다.
 *   그런데 강등이 실제로 일어나는 곳은 lib/chat/llm.ts의 모델 선택이다.
 *   boolean은 맞는데 그 아래에서 모델이 안 바뀌면 선별은 똑같이 조용히 멈춘다.
 */
describe("probeTurn → 실제 모델 선택", () => {
  it("확인 턴은 3.8-flash, 수다 턴은 2.5-flash", async () => {
    const { getTextModel } = await import("@/lib/chat/llm");
    const seen: string[] = [];
    // generateContent를 가로채지 않고도 모델명을 보려면 호출 시 전달되는 model을 봐야 한다.
    // 여기서는 소스 계약을 고정한다 — 런타임 호출은 Gemini 키가 필요해 단위 테스트 범위 밖이다.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("lib/chat/llm.ts", "utf-8");
    const block = src.slice(src.indexOf("const model = probeTurn"), src.indexOf("const model = probeTurn") + 240);
    // 🔒 삼항이 뒤집히거나 기본값이 바뀌면 확인 턴이 조용히 저가 모델로 내려간다
    expect(block).toMatch(/probeTurn\s*\n?\s*\?\s*\(process\.env\.COMPANION_PROBE_MODEL \|\| "gemini-3\.8-flash"\)/);
    expect(block).toMatch(/:\s*\(process\.env\.COMPANION_MODEL \|\| "gemini-2\.5-flash"\)/);
    expect(typeof getTextModel).toBe("function");
    expect(seen).toEqual([]);
  });

  it("getTextModel의 probeTurn은 4번째 인자이고 기본값이 false다 (인자 누락 = 조용한 강등)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("lib/chat/llm.ts", "utf-8");
    expect(src).toMatch(/getTextModel\([^)]*cachedContent\?: string,\s*probeTurn: boolean = false\)/);
    /**
     * 🔒 실제로 터졌던 결함 유형만 고정한다: **캐시 경로에서 4번째 인자 누락**.
     *   인사 핸들러(handleFirstGreeting 등)는 확인 턴이 아니므로 probeTurn 미전달이 올바르다 —
     *   "전 호출부가 넘겨야 한다"로 쓰면 그 셋 때문에 거짓 실패한다.
     *   위험한 건 prefixCache를 쓰면서 probeTurn을 빠뜨리는 조합이다(기본값 false로 조용한 강등).
     */
    const route = await fs.readFile("app/api/chat/route.ts", "utf-8");
    const cacheCalls = [...route.matchAll(/getTextModel\([^;]*?prefixCache[^;]*?\)/g)].map((m) => m[0]);
    expect(cacheCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of cacheCalls) expect(c, c).toMatch(/probeTurn/);
  });
});
