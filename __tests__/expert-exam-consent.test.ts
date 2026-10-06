/**
 * 검진 시작 동의 — **행위** 테스트(실제 라우트 핸들러를 호출한다).
 *
 * 2026-10-06 적대 감사 두 건:
 *   ① 서버가 환자 검진 동의 없이도 세션을 열었다(UI 모달만 통제) → 전문가가 API를 직접 부르면 우회.
 *   ② 검진 모달 동의로 **전체 약관 동의(consentedAt v1.1)**까지 찍었다. 모달은 "검진 답변·점수를 담당
 *      전문가에게"만 고지하는데 v1.1은 일상 대화·응급·보호자 제공까지 포함한다(고지 범위 초과 기록).
 *
 * 목 체제: 세션·레이트리밋·prisma(연결·사용자·raw SQL).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sql: string[] = [];
const userWrites: unknown[] = [];

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { id: "u-pro", screeningMode: "pro" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expertPatient: { findUnique: vi.fn(async () => ({ status: "active" })) },
    user: {
      findUnique: vi.fn(async () => ({ screeningMode: "user" })),
      updateMany: vi.fn(async (a: unknown) => { userWrites.push(a); return { count: 1 }; }),
      update: vi.fn(async (a: unknown) => { userWrites.push(a); return {}; }),
    },
    $executeRawUnsafe: vi.fn(async (q: string) => { sql.push(q.trim().split(/\s+/).slice(0, 3).join(" ")); return 1; }),
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

const { POST } = await import("@/app/api/expert/exam/route");

async function start(body: Record<string, unknown>) {
  const res = await POST(new Request("http://localhost/api/expert/exam", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", patientId: "u-patient", conversationId: "c-1", ...body }),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => { sql.length = 0; userWrites.length = 0; });

describe("검진 동의 없이는 세션을 열지 않는다", () => {
  it.each([[{}], [{ patientConsent: false }], [{ patientConsent: "true" }]])("patientConsent=%j → 403, 세션 미생성", async (extra) => {
    const r = await start(extra);
    // 🔒 이전: 서버는 동의를 기록만 하고 세션은 그냥 열었다 — API 직접 호출로 모달 우회
    expect(r.status).toBe(403);
    expect(r.body.needExamConsent).toBe(true);
    expect(sql.some((s) => s.startsWith("INSERT INTO exam_session"))).toBe(false);
  });
});

describe("검진 동의는 검진 동의로만 기록한다", () => {
  it("동의하면 세션이 열리고 감사 기록(exam_consent)이 남는다", async () => {
    const r = await start({ patientConsent: true });
    expect(r.status).toBe(200);
    expect(typeof r.body.sessionId).toBe("string");
    expect(sql.some((s) => s.startsWith("INSERT INTO exam_session"))).toBe(true);
    expect(sql.some((s) => s.startsWith("INSERT INTO expert_access_log"))).toBe(true);
  });

  it("🔒 전체 약관 동의(consentedAt)는 찍지 않는다 — 모달이 고지한 범위를 넘는다", async () => {
    await start({ patientConsent: true });
    // 이전: user.updateMany({ consentedAt: now, consentVersion: "1.1" }) — 일상 대화·응급·보호자 제공까지 열렸다
    expect(userWrites).toEqual([]);
  });
});
