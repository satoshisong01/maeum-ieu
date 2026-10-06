/**
 * /api/voiceprint 게이트 — **행위** 테스트. 성문(화자 특징 벡터)은 생체인식정보다.
 *
 * 2026-10-06 이전: 대상자의 동의·역할을 전혀 보지 않고 성문을 만들었다(마이페이지 링크는 모든 계정에
 *   보인다). → 만들거나 대조하는 동작은 "동의한 어르신 계정"만. 지우는 동작(reset)은 언제나 허용.
 * ⚠ 동의서·개인정보처리방침에 성문 저장 고지가 없는 문제는 코드로 해결되지 않는다(FIXLOG OPEN).
 *
 * 목 체제: 세션·레이트리밋·prisma(사용자·연결·raw SQL). 성문 계산은 실제 코드.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let session: { user: { id: string; screeningMode?: string } } = { user: { id: "u-elder", screeningMode: "user" } };
const users: Record<string, { consentedAt: Date | null; screeningMode: string }> = {};
const writes: string[] = [];

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null) },
    expertPatient: { findUnique: vi.fn(async () => ({ status: "active" })) },
    $executeRawUnsafe: vi.fn(async (sql: string) => { writes.push(sql.trim().split(/\s+/).slice(0, 3).join(" ")); return 1; }),
    $queryRawUnsafe: vi.fn(async () => [{ embedding: new Array(192).fill(0.1) }]),
  },
}));

const { VOICEPRINT_DIM } = await import("@/lib/voiceprint/constants");
const { POST } = await import("@/app/api/voiceprint/route");
const EMB = Array.from({ length: VOICEPRINT_DIM }, (_, i) => Math.sin(i + 1));

async function post(body: Record<string, unknown>) {
  const res = await POST(new Request("http://localhost/api/voiceprint", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  writes.length = 0;
  for (const k of Object.keys(users)) delete users[k];
  users["u-elder"] = { consentedAt: new Date("2026-01-01"), screeningMode: "user" };
  session = { user: { id: "u-elder", screeningMode: "user" } };
});

describe("본인 등록", () => {
  it("동의한 어르신은 등록된다", async () => {
    const r = await post({ action: "enroll", embedding: EMB, sampleSecs: 8 });
    expect(r.status).toBe(200);
    expect(writes.some((w) => w.startsWith("INSERT INTO speaker_voiceprint_sample"))).toBe(true);
  });

  it("미동의 어르신은 403 needConsent — 성문을 만들지 않는다", async () => {
    users["u-elder"].consentedAt = null;
    const r = await post({ action: "enroll", embedding: EMB });
    expect(r.status).toBe(403);
    expect(r.body.needConsent).toBe(true);
    // 🔒 2026-10-06 이전: 아무 확인 없이 생체정보(성문)가 저장됐다
    expect(writes).toEqual([]);
  });

  it.each(["guardian", "pro", "general"])("%s 본인 계정은 403 wrongRole — 쓸 곳도 없는 생체정보를 만들지 않는다", async (role) => {
    session = { user: { id: `u-${role}`, screeningMode: role } };
    users[`u-${role}`] = { consentedAt: new Date("2026-01-01"), screeningMode: role };
    const r = await post({ action: "enroll", embedding: EMB });
    expect(r.status).toBe(403);
    expect(r.body.wrongRole).toBe(true);
    expect(writes).toEqual([]);
  });

  it("대조(verify)도 같은 게이트를 탄다", async () => {
    users["u-elder"].consentedAt = null;
    const r = await post({ action: "verify", embedding: EMB });
    expect(r.status).toBe(403);
  });
});

describe("전문가 대리 등록", () => {
  beforeEach(() => { session = { user: { id: "u-pro", screeningMode: "pro" } }; });

  it("연결된 환자가 미동의면 403 — 환자 동의를 본다", async () => {
    users["u-patient"] = { consentedAt: null, screeningMode: "user" };
    const r = await post({ action: "enroll", embedding: EMB, targetUserId: "u-patient" });
    expect(r.status).toBe(403);
    expect(r.body.needConsent).toBe(true);
    expect(writes).toEqual([]);
  });

  it("연결된 환자가 일반인 계정이면 403", async () => {
    users["u-patient"] = { consentedAt: new Date(), screeningMode: "general" };
    const r = await post({ action: "enroll", embedding: EMB, targetUserId: "u-patient" });
    expect(r.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("동의한 어르신 환자는 등록된다", async () => {
    users["u-patient"] = { consentedAt: new Date(), screeningMode: "user" };
    const r = await post({ action: "enroll", embedding: EMB, targetUserId: "u-patient" });
    expect(r.status).toBe(200);
  });
});

describe("삭제는 언제나 허용", () => {
  it("미동의여도 reset(전부 삭제)은 된다 — 지울 권리는 동의와 무관하다", async () => {
    users["u-elder"].consentedAt = null;
    const r = await post({ action: "reset" });
    expect(r.status).toBe(200);
    expect(writes.filter((w) => w.startsWith("DELETE FROM")).length).toBe(2);
  });
});
