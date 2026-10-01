/**
 * 역할별 접근 권한 통합 테스트 — 라우트 핸들러를 직접 호출해 프라이버시 경계를 고정한다.
 *
 * 왜 필요한가: 동의서 §4의 프라이버시 모델(일상 대화 원문은 보호자·의사 모두 비공개,
 * 검진 상세는 의사만, 어르신 본인은 결과 비공개)은 코드 여러 곳에 흩어져 있어
 * 리팩터링 한 번으로 조용히 깨질 수 있다. 세션만 바꿔 같은 핸들러를 호출해 경계를 검증한다.
 *
 * 성격: 통합 테스트(화이트박스 — 세션을 주입해 분기 커버) + 보안 회귀 테스트.
 * DB는 실제로 쓰지 않는다 — prisma를 스텁해 응답 형태·분기만 검증(단위 격리).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const MARKER = "표식문구_일상대화_원문";
const PATIENT_ID = "patient-1";

// ── 세션 주입 ──
let currentSession: { user: { id: string; name?: string; screeningMode: string } } | null = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => currentSession) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

// ── prisma 스텁 — 원문이 담긴 데이터를 넣어두고, 응답에 새는지 본다 ──
const messages = [
  { id: "m1", role: "user", content: MARKER, isAnomaly: false, emergencyLevel: null, emergencyEvidence: null, speakerLabel: null, createdAt: new Date(), notifiedAt: null },
  { id: "m2", role: "user", content: "가슴이 아프고 숨이 안 쉬어져", isAnomaly: true, emergencyLevel: 3, emergencyEvidence: "chest_pain:t", speakerLabel: null, createdAt: new Date(), notifiedAt: new Date() },
];
const patient = { id: PATIENT_ID, name: "김순자", age: 79, gender: "female", createdAt: new Date(), companionName: "민지" };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => patient), findMany: vi.fn(async () => []) },
    expertPatient: {
      // doctor-1 / guardian-1 만 연결됨. outsider-1 은 미연결 → 차단되어야 함
      findUnique: vi.fn(async ({ where }: { where: { expertUserId_patientUserId?: { expertUserId: string } } }) => {
        const id = where?.expertUserId_patientUserId?.expertUserId;
        return id === "doctor-1" || id === "guardian-1" ? { status: "active" } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { expertUserId?: string } }) =>
        where?.expertUserId === "doctor-1" || where?.expertUserId === "guardian-1"
          ? { id: "link-1", status: "active" } : null),
      findMany: vi.fn(async () => [{ expertUserId: "guardian-1" }]),
    },
    message: {
      // where를 실제로 적용한다 — 필터(emergencyLevel>=2·role=user)를 누가 지우면
      // 일상 대화 원문이 응답에 섞여 테스트가 실패하도록(회귀 가드).
      findMany: vi.fn(async (args?: { where?: { emergencyLevel?: { gte?: number }; role?: string } }) => {
        const w = args?.where ?? {};
        return messages.filter((m) => {
          if (w.role && m.role !== w.role) return false;
          if (w.emergencyLevel?.gte !== undefined && (m.emergencyLevel ?? 0) < w.emergencyLevel.gte) return false;
          return true;
        });
      }),
      findFirst: vi.fn(async () => messages[1]),
      count: vi.fn(async () => 1),
      aggregate: vi.fn(async () => ({ _count: { _all: 1 }, _max: { createdAt: new Date() } })),
      update: vi.fn(async () => ({})),
    },
    conversation: { findUnique: vi.fn(async () => ({ id: "conv-1" })), findFirst: vi.fn(async () => ({ id: "conv-1" })) },
    medicationSchedule: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 0),
  },
}));

// 등급·추세 계산은 실제 모듈을 쓰되 DB 의존부만 최소 스텁
vi.mock("@/lib/health/cognitive-tier", () => ({
  getCognitiveTier: vi.fn(async () => ({ tier: "중증", avg: 1.6, text: "의사 진료를 권장합니다." })),
  getCognitiveTrend: vi.fn(async () => ({ status: "악화", text: "최근 악화 추세" })),
  getTierReliability: vi.fn(async () => ({ showLevel: true, reason: "", checkCount: 30 })),
}));

/** 핸들러는 테스트마다 새로 import — 모듈 수준 캐시로 세션이 굳지 않게 */
async function callPatientDetail(session: typeof currentSession) {
  currentSession = session;
  vi.resetModules();
  const mod = await import("@/app/api/expert/patients/[id]/route");
  const res = await mod.GET(new Request(`http://t/api/expert/patients/${PATIENT_ID}`), {
    params: Promise.resolve({ id: PATIENT_ID }),
  } as never);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

const S = {
  elder: { user: { id: PATIENT_ID, name: "김순자", screeningMode: "user" } },
  guardian: { user: { id: "guardian-1", name: "보호자", screeningMode: "guardian" } },
  doctor: { user: { id: "doctor-1", name: "의사", screeningMode: "pro" } },
  outsider: { user: { id: "outsider-1", name: "외부의사", screeningMode: "pro" } },
  general: { user: { id: "general-1", name: "일반인", screeningMode: "general" } },
};

beforeEach(() => { currentSession = null; });

describe("환자 상세 조회 — 역할별 경계", () => {
  it("보호자는 등급 요약만 받고 대화 원문은 받지 못한다", async () => {
    const r = await callPatientDetail(S.guardian);
    expect(r.status).toBe(200);
    expect(r.json?.viewerRole).toBe("guardian");
    expect(typeof r.json?.statusLine).toBe("string");
    expect((r.json?.statusLine as string).length).toBeGreaterThan(0);
    // 🔒 원문·응급 발화 원문·문항별 상세 모두 없어야 함
    expect(r.text).not.toContain(MARKER);
    expect(r.text).not.toContain("숨이 안 쉬어져");
    expect(r.json).not.toHaveProperty("assessments");
    expect(r.json).not.toHaveProperty("sessions");
  });

  it("의사는 상세를 받지만 일상 대화 원문은 받지 못한다", async () => {
    const r = await callPatientDetail(S.doctor);
    expect(r.status).toBe(200);
    expect(r.json?.viewerRole).not.toBe("guardian");
    // 🔒 일상 대화(emergencyLevel 없음)는 의사에게도 비공개 — 동의서 §4
    expect(r.text).not.toContain(MARKER);
    // 반면 응급 발화(L2+)는 의사에게 공개되는 것이 설계 — 안전을 위해 필요
    expect(r.text).toContain("숨이 안 쉬어져");
  });

  it("연결되지 않은 전문가는 차단된다", async () => {
    const r = await callPatientDetail(S.outsider);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toContain(MARKER);
  });

  it("어르신 본인은 환자 상세를 열람할 수 없다", async () => {
    const r = await callPatientDetail(S.elder);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toContain(MARKER);
  });

  it("일반인(general)은 차단된다", async () => {
    const r = await callPatientDetail(S.general);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("비로그인은 401", async () => {
    const r = await callPatientDetail(null);
    expect(r.status).toBe(401);
  });
});

describe("본인 결과 열람 차단 — 어르신(user)", () => {
  async function callOwn(path: "health-logs" | "summary", session: typeof currentSession) {
    currentSession = session;
    vi.resetModules();
    const mod = path === "health-logs"
      ? await import("@/app/api/health-logs/route")
      : await import("@/app/api/summary/route");
    const res = await (mod as unknown as { GET: () => Promise<Response> }).GET();
    return { status: res.status, text: await res.text() };
  }

  it("health-logs — 어르신 본인 403", async () => {
    const r = await callOwn("health-logs", S.elder);
    expect(r.status).toBe(403);
  });

  it("summary — 어르신 본인 403", async () => {
    const r = await callOwn("summary", S.elder);
    expect(r.status).toBe(403);
  });

  it("health-logs — 비로그인 401", async () => {
    const r = await callOwn("health-logs", null);
    expect(r.status).toBe(401);
  });
});

describe("보호자 계정은 대화 대상이 아니다", () => {
  it("/api/chat 소스가 guardian을 403으로 차단한다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/chat/route.ts", "utf-8");
    // mode 유니온에 guardian이 없어 else → "user"로 강등되던 결함(2026-10-01).
    //   guardian 발화가 보호자 본인의 cognitive_assessments로 기록되고 C2 알림 대상이 됐다.
    expect(src).toMatch(/screeningMode === "guardian"[\s\S]{0,200}status:\s*403/);
  });

  it("Live 경로도 인지 분석을 user 모드로만 수행한다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/live/turn/route.ts", "utf-8");
    // 기존에는 general만 제외해 guardian·pro 발화가 분석 대상이 됐다.
    expect(src).toMatch(/mode === "user"[\s\S]{0,40}userMsgId/);
    expect(src).not.toMatch(/mode !== "general"[\s\S]{0,40}userMsgId/);
  });

  it("Live 경로에 건강정보 동의 게이트가 있다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/live/turn/route.ts", "utf-8");
    // /api/chat에는 있는데 Live에는 없어서 미동의 어르신이 건강데이터를 생성할 수 있었다.
    expect(src).toMatch(/consentedAt/);
    expect(src).toMatch(/needConsent/);
  });
});

describe("건강정보 동의 게이트 범위", () => {
  it("일반인(general)도 동의 없이 대화·자가점검을 저장할 수 없다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/chat/route.ts", "utf-8");
    // 결함(2026-10-01): 게이트가 user에만 걸려 있어 일반인이 동의 없이 PHQ-9·GAD-7
    //   응답·점수(mental_assessments)와 대화 원문을 저장했다. 우울·불안 점수는 민감정보다.
    expect(src).toMatch(/mode === "user" \|\| mode === "general"[\s\S]{0,400}consentedAt/);
    expect(src).toMatch(/consentedAt[\s\S]{0,200}needConsent[\s\S]{0,80}403/);
  });

  it("홈 화면도 미동의 일반인을 /consent로 보낸다 — 403으로 끊기지 않게", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/page.tsx", "utf-8");
    expect(src).toMatch(/mode === "general"[\s\S]{0,300}consentedAt \? "\/mental" : "\/consent"/);
  });

  it("Live 경로의 동의 게이트는 역할을 가리지 않는다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/live/turn/route.ts", "utf-8");
    const gate = src.slice(src.indexOf("건강정보 수집 동의 게이트"));
    // 🔒 mode 조건이 붙으면 특정 역할이 동의 없이 건강데이터를 만들 수 있게 된다
    expect(gate.slice(0, 400)).not.toMatch(/mode === "/);
  });

  it("동의 고지 문구가 일반인 수집 항목과 일치한다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/consent/page.tsx", "utf-8");
    // 일반인은 인지 선별 대상이 아니다 — "어르신의 인지"로 고지하면 실제와 어긋난다
    expect(src).toMatch(/isGeneral/);
    expect(src).toMatch(/자가점검\(우울·불안·성격\) 응답과 점수/);
  });
});
