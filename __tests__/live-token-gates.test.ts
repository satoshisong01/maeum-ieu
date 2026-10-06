/**
 * /api/live/token 게이트 — **행위** 테스트(실제 라우트 핸들러를 호출한다).
 *
 * 2026-10-06 정정 두 가지를 고정한다:
 *   ① 보호자(guardian)가 **어르신 페르소나**로 세션을 받던 결함 — mode 판정이 "일반인 외에는 user"라
 *      보호자가 80/20 + 인지 확인 질문 세션을 받았다. /api/chat은 2026-10-01에 이미 403으로 막았다.
 *   ② 일일 한도 대상이 `!== "general"`이라 주석("/api/chat과 같은 상한")과 달리 pro까지 막고 있었다.
 *
 * 목 체제: 세션·플래그·레이트리밋·prisma·한도·프롬프트·날씨·Gemini 토큰 발급. 외부 호출은 없다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let session: { user: { id: string; screeningMode?: string } } | null = null;
let usage = { used: 0, limit: 200, exceeded: false, nearLimit: false, remaining: 200 };

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/feature-flags", () => ({ isLiveBetaEnabledServer: () => true }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: { conversation: { findUnique: vi.fn(async () => ({ userId: session?.user.id })) } },
}));
const getDailyUsage = vi.fn(async () => usage);
vi.mock("@/lib/usage/daily-limit", () => ({
  getDailyUsage: () => getDailyUsage(),
  buildDailyLimitReplyForUser: vi.fn(async () => "어르신, 오늘 이야기 많이 나눴네요. 내일 또 만나요."),
}));
// 타입은 제네릭으로 준다 — 미사용 매개변수로 주면 린트 경고가 부채로 쌓인다(F10)
const buildSystemPrompt = vi.fn<(a: { mode: string }) => Promise<{ stablePrompt: string }>>(
  async () => ({ stablePrompt: "STABLE" }));
vi.mock("@/lib/chat/prompt", () => ({ buildSystemPrompt: (a: { mode: string }) => buildSystemPrompt(a) }));
vi.mock("@/lib/chat/weather", () => ({ getWeatherContext: vi.fn(async () => ({ promptText: "맑음", description: "맑음" })) }));
const createToken = vi.fn(async () => ({ name: "tok-1" }));
vi.mock("@google/genai", () => ({
  Modality: { AUDIO: "AUDIO" },
  GoogleGenAI: class { authTokens = { create: createToken }; },
}));

process.env.GEMINI_API_KEY = "test-key";
const { POST } = await import("@/app/api/live/token/route");

async function call() {
  const res = await POST(new Request("http://localhost/api/live/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "c-1" }),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  usage = { used: 10, limit: 200, exceeded: false, nearLimit: false, remaining: 190 };
  session = { user: { id: "u-elder", screeningMode: "user" } };
  for (const f of [getDailyUsage, buildSystemPrompt, createToken]) f.mockClear();
});

describe("보호자 계정 — 세션을 받지 못한다", () => {
  it("guardian은 403이고 토큰도 프롬프트도 만들어지지 않는다", async () => {
    session = { user: { id: "u-guardian", screeningMode: "guardian" } };
    const r = await call();
    expect(r.status).toBe(403);
    // 🔒 2026-10-06 이전: 보호자에게 **어르신 페르소나** 세션이 발급됐다
    expect(buildSystemPrompt).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
  });
});

describe("일일 한도 — 대상은 어르신만 (/api/chat과 같은 범위)", () => {
  it("어르신이 한도를 넘으면 403 + 마무리 인사(오류 문구가 아니다)", async () => {
    usage = { used: 200, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call();
    expect(r.status).toBe(403);
    expect(r.body.dailyLimitReached).toBe(true);
    expect(typeof r.body.message).toBe("string");
    expect(createToken).not.toHaveBeenCalled();
  });

  it("어르신이 한도 안이면 토큰이 발급된다", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.token).toBe("tok-1");
  });

  it.each(["pro", "general"])("%s 는 한도를 조회하지 않는다", async (role) => {
    session = { user: { id: `u-${role}`, screeningMode: role } };
    usage = { used: 999, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call();
    // 🔒 2026-10-06 이전: 조건이 `!== "general"`이라 pro도 어르신 한도로 막혔다
    expect(getDailyUsage).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
  });
});

describe("페르소나 — 역할에 맞는 프롬프트", () => {
  it("일반인은 general, 어르신은 user 프롬프트로 세션을 받는다", async () => {
    session = { user: { id: "u-general", screeningMode: "general" } };
    await call();
    session = { user: { id: "u-elder", screeningMode: "user" } };
    await call();
    expect(buildSystemPrompt.mock.calls.map((c) => c[0].mode)).toEqual(["general", "user"]);
  });
});
