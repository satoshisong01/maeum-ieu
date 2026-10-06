/**
 * /api/observe/turn — **행위** 테스트(실제 라우트 핸들러를 호출한다).
 *
 * 상시 감시(관찰자 모드)는 혼자 있는 중증 어르신의 혼잣말을 듣는 경로다. 대화가 없어
 * 누가 대신 알아챌 기회도 없으므로, 여기서 응급을 버리면 그대로 끝이다.
 *
 * 2026-10-06 수정(적대 감사 → 재현): STT 저신뢰 게이트가 응급 판정 **앞**에 있어서
 *   보속증(같은 말 반복)으로 외친 L3가 저장·알림 없이 버려졌다. /api/chat은 2026-10-02에 고쳤다.
 *
 * 목 체제: 세션·레이트리밋·prisma·전사(Gemini)·백스톱·알림. 감지·STT 신뢰도 판정은 **실제 코드** —
 *   두 판정이 같은 발화에 대해 엇갈리는 게 이 결함의 본질이라, 둘 다 진짜여야 의미가 있다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pending: Promise<unknown>[] = [];
let session: { user: { id: string; name?: string; screeningMode?: string } } | null = null;
let transcript = "";

vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => { pending.push(Promise.resolve().then(fn)); } };
});
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
const messageCreate = vi.fn<(a: { data: { emergencyLevel: number | null; content: string } }) => Promise<{ id: string }>>(
  async () => ({ id: "m-obs" }));
// L1 누적 집계(countRecentL1Signals → prisma.message.count) — 승격 검증에 쓴다
let recentL1 = 0;
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: vi.fn(async () => ({ id: "c-obs" })), create: vi.fn(async () => ({ id: "c-obs" })) },
    message: {
      create: (a: { data: { emergencyLevel: number | null; content: string } }) => messageCreate(a),
      count: vi.fn(async () => recentL1),
    },
  },
}));
vi.mock("@/lib/chat/llm", () => ({
  getGenAI: () => ({ models: { generateContent: vi.fn(async () => ({})) } }),
  extractText: () => transcript,          // 전사 결과를 테스트가 정한다
  COMPANION_SAFETY_SETTINGS: [],
  logUsage: () => {},
}));
vi.mock("@/lib/chat/emergency-llm", () => ({ detectEmergencyLLM: vi.fn(async () => null) }));
const notifyGuardian = vi.fn<(p: { level: number; content: string }) => Promise<{ sent: boolean }>>(
  async () => ({ sent: true }));
vi.mock("@/lib/chat/emergency-notify", () => ({ notifyGuardian: (p: { level: number; content: string }) => notifyGuardian(p) }));
vi.mock("@/lib/chat/emergency-last-resort", () => ({ lastResortEmergency: vi.fn(async () => {}) }));

const { POST } = await import("@/app/api/observe/turn/route");
const { evaluateSttConfidence } = await import("@/lib/chat/stt-confidence");
const { detectEmergency } = await import("@/lib/chat/emergency");

async function call(text: string) {
  transcript = text;
  const res = await POST(new Request("http://localhost/api/observe/turn", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: "UklGRg==", mimeType: "audio/wav" }),
  }));
  await Promise.all(pending.splice(0));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  pending.length = 0;
  recentL1 = 0;
  session = { user: { id: "u-elder", name: "김어르신", screeningMode: "user" } };
  messageCreate.mockClear();
  notifyGuardian.mockClear();
});

describe("보속증 외침 — STT 저신뢰여도 응급은 버리지 않는다", () => {
  const PERSEVERATION = "죽고 싶어 죽고 싶어 죽고 싶어 죽고 싶어";

  it("전제: 이 발화는 STT 게이트에서 탈락하면서 동시에 L3다 (두 판정이 엇갈린다)", () => {
    // 이 전제가 깨지면(예: STT 게이트가 반복을 허용하게 바뀌면) 아래 테스트는 다른 것을 검증하게 된다
    expect(evaluateSttConfidence(PERSEVERATION).pass).toBe(false);
    expect(detectEmergency(PERSEVERATION).level).toBe(3);
  });

  it("저장되고, 응급 등급이 실리고, 보호자 알림이 나간다", async () => {
    const r = await call(PERSEVERATION);
    expect(r.status).toBe(200);
    // 🔒 2026-10-06 이전: { ok: true, skipped: true, reason: "vocabulary collapse" }로 끝났다
    expect(r.body.skipped).toBeUndefined();
    expect(r.body.emergencyLevel).toBe(3);
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(messageCreate.mock.calls[0][0].data.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(notifyGuardian.mock.calls[0][0].level).toBe(3);
  });
});

describe("저신뢰 + 응급 아님 — 기존처럼 버린다 (비용·노이즈 보호)", () => {
  it("반복 잡담은 저장하지 않는다", async () => {
    const t = "그래 그래 그래 그래 그래 그래";
    expect(evaluateSttConfidence(t).pass, "전제: 저신뢰").toBe(false);
    expect(detectEmergency(t).level, "전제: 응급 아님").toBe(0);
    const r = await call(t);
    expect(r.body.skipped).toBe(true);
    expect(messageCreate).not.toHaveBeenCalled();
    expect(notifyGuardian).not.toHaveBeenCalled();
  });

  it("빈 전사는 저장하지 않고, 유료 백스톱도 부르지 않는다", async () => {
    const { detectEmergencyLLM } = await import("@/lib/chat/emergency-llm");
    vi.mocked(detectEmergencyLLM).mockClear();
    const r = await call("");
    expect(r.body.skipped).toBe(true);
    expect(messageCreate).not.toHaveBeenCalled();
    // 🔒 상시 감시는 침묵·잡음 조각이 잦다 — 빈 전사마다 LLM을 부르면 비용이 조각 수만큼 샌다
    expect(detectEmergencyLLM).not.toHaveBeenCalled();
  });
});

describe("정상 신뢰도 응급 — 원래 경로 회귀 확인", () => {
  it("한 번 외친 L3도 그대로 알림", async () => {
    const r = await call("숨이 안 쉬어져");
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });
});

describe("L1 혼잣말 24시간 누적 → L2 승격 — /api/chat과 같은 규칙", () => {
  const L1 = "요즘 입맛이 하나도 없어";

  it("전제: 예문은 L1이다", () => {
    expect(detectEmergency(L1).level).toBe(1);
  });

  it("최근 24시간 L1이 2건이면 이번 것으로 3건 → L2로 저장하고 보호자에게 알린다", async () => {
    recentL1 = 2;
    const r = await call(L1);
    expect(r.status).toBe(200);
    // 🔒 2026-10-06 이전: 상시 감시엔 승격이 없어, 대화가 어려운 어르신이 하루 종일 "입맛이 없다"고
    //   혼잣말해도 보호자에게 아무것도 가지 않았다(이 경로에서 L1은 죽은 규칙이었다)
    expect(r.body.emergencyLevel).toBe(2);
    expect(messageCreate.mock.calls[0][0].data.emergencyLevel).toBe(2);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(notifyGuardian.mock.calls[0][0].level).toBe(2);
  });

  it("누적이 모자라면 L1로 저장만 한다", async () => {
    recentL1 = 0;
    const r = await call(L1);
    expect(r.status).toBe(200);
    expect(messageCreate.mock.calls[0][0].data.emergencyLevel).toBe(1);
    expect(notifyGuardian).not.toHaveBeenCalled();
  });
});
