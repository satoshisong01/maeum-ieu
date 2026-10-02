/**
 * 응급 알림 복원력 회귀 테스트 — DB 장애 시 알림이 살아남는지 고정한다.
 *
 * 성격: 단위 테스트(화이트박스 — prisma를 스텁해 실패 분기를 강제 실행)
 *
 * 왜 필요한가: 2026-10-01 복원력 수정 당시 기존 게이트 4개(tsc / vitest 398 /
 *   safety-regression 342 / notify-verify 31) 중 **새 분기를 하나도 실행하는 것이 없었다.**
 *   safety-regression은 detectEmergency 감지 배터리이고, notify-verify는 DB가 정상인
 *   해피패스만 본다. 즉 수정 전 코드로도 전부 통과했을 테스트였다.
 *   여기서 고정하는 건 "DB가 깨져도 보호자에게 알림이 간다"는 계약 자체다.
 *
 * ⚠ fail-open이 always-open으로 번지는 회귀를 특히 조심한다(케이스 2).
 *   중복 알림은 보호자가 한 번 더 확인하면 끝이지만, 알림 폭주는 신뢰를 잃고
 *   공용 Gmail 발신 한도를 태워 **다른 환자의 알림까지** 끊는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  message: { findFirst: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  expertPatient: { findMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const pushMock = vi.fn(async () => ({ sent: 1, failed: 0 }));
const emailMock = vi.fn(async () => true);
vi.mock("@/lib/notify/push-fcm", () => ({ sendEmergencyPush: (...a: unknown[]) => pushMock(...(a as [])) }));
vi.mock("@/lib/notify/email", () => ({ sendEmergencyEmail: (...a: unknown[]) => emailMock(...(a as [])) }));
vi.mock("@/lib/crypto", () => ({ decryptPII: (s: string) => s, encryptPII: (s: string) => s }));

const P = {
  userId: "u1", userName: "김응급", level: 3 as const, category: "medical_acute",
  content: "숨이 안 쉬어져", aiReply: "119에 전화해주세요", createdAt: new Date("2026-10-01T12:00:00Z"),
};

async function notify(extra: Record<string, unknown> = {}) {
  const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
  return notifyGuardian({ ...P, messageId: "m1", ...extra } as Parameters<typeof notifyGuardian>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 기본값: 중복 아님 · 보호자 이메일 있음 · 연결 보호자 1명 · 마킹 성공
  db.message.findFirst.mockResolvedValue(null);
  db.message.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: "보호자" });
  db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }]);
});

describe("DB 장애에도 알림은 나간다", () => {
  it("dedup 조회가 실패해도 발송한다 (fail-open)", async () => {
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
    const r = await notify();
    expect(r.sent).toBe(true);
    expect(r.channels.length).toBeGreaterThan(0);
  });

  it("보호자 연락처 조회가 실패해도 FCM은 나간다", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(r.channels).toContain("fcm");
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("FCM 대상 조회가 실패해도 이메일은 나간다 — 이전엔 통째로 날아갔다", async () => {
    db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(emailMock).toHaveBeenCalledTimes(1);   // 🔒 격리 전엔 0회였다
    expect(r.channels).toContain("email");
  });

  it("발송 성공 후 마킹이 실패해도 성공으로 보고한다", async () => {
    db.message.update.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(r.sent).toBe(true);                     // 🔒 이전엔 예외가 터져 'L3 error'로 둔갑
    expect(r.channels.length).toBeGreaterThan(0);
  });

  it("messageId가 없으면 마킹을 건너뛰고도 발송한다 (저장 실패 턴)", async () => {
    const r = await notify({ messageId: undefined });
    expect(r.sent).toBe(true);
    expect(db.message.update).not.toHaveBeenCalled();  // 🔒 undefined로 update 치면 예외
  });

  it("두 조회 모두 실패하면 '알림 대상 없음'으로 보고하지 않는다", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(r.sent).toBe(false);
    // 🔒 조회 실패를 "보호자가 등록 안 됨"으로 적으면 운영자가 원인을 영원히 못 찾는다
    expect(r.reason ?? "").not.toContain("알림 대상 없음");
  });
});

describe("fail-open이 always-open으로 번지지 않는다", () => {
  it("dedup 조회가 성공해서 중복이면 발송하지 않는다", async () => {
    db.message.findFirst.mockResolvedValue({ id: "prev" });
    const r = await notify();
    expect(r.sent).toBe(false);                    // 🔒 이게 깨지면 알림 폭주
    expect(pushMock).not.toHaveBeenCalled();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("L2 이력이 있어도 L3 격상은 통과한다", async () => {
    // isDuplicate는 emergencyLevel >= level 로 조회한다 — L2만 있으면 L3 조회엔 안 걸린다
    db.message.findFirst.mockImplementation(async (args: { where?: { emergencyLevel?: { gte?: number } } }) => {
      const gte = args?.where?.emergencyLevel?.gte ?? 0;
      return gte <= 2 ? { id: "prevL2" } : null;   // L2 이력만 존재
    });
    const r = await notify({ level: 3 });
    expect(r.sent).toBe(true);                     // 🔒 경증 호소 → 악화 경로가 억제되면 안 된다
  });
});

describe("saveMessages 부분 실패 — 응급 턴의 dedup 앵커 보존", () => {
  it("assistant 쓰기가 실패해도 userMsgId를 돌려준다", async () => {
    vi.resetModules();
    const created: string[] = [];
    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        message: {
          create: vi.fn(async ({ data }: { data: { role: string } }) => {
            created.push(data.role);
            if (data.role === "assistant") throw new Error("write failed");
            return { id: "user-msg-1", content: "숨이 안 쉬어져" };
          }),
        },
        conversation: { update: vi.fn() },
      },
    }));
    vi.doMock("@/lib/rag", () => ({ saveMessageEmbedding: vi.fn(async () => {}) }));
    const { saveMessages } = await import("@/lib/chat/messages");
    const r = await saveMessages({
      conversationId: "c1", userId: "u1", userContent: "숨이 안 쉬어져",
      assistantContent: "119에 전화해주세요", emergencyLevel: 3, emergencyEvidence: "medical_acute:t",
      skipUserEmbedding: true, skipAssistantEmbedding: true,
    });
    // 🔒 이게 빈 값이면 notifiedAt 마킹이 불가 → pilot-daily-check가 거짓 🔴을 내고
    //    dedup 앵커가 없어 같은 응급이 다음 턴에 재발송된다
    expect(r.userMsgId).toBe("user-msg-1");
    expect(created).toContain("assistant");
  });
});

describe("요청이 통째로 실패해도 L3는 살아남는다 (최후 안전망)", () => {
  /**
   * handleEmergencyL3에 **도달하기 전** DB 호출(동의 게이트·소유권 검증·buildSystemPrompt)이
   * 터지면 500으로 끝나 119 안내도 보호자 알림도 0건이었다. 그 catch 경로를 고정한다.
   */
  it("POST catch가 emergencyLastResort로 흐른다 — 맨 500 return이 되살아나면 실패", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/chat/route.ts", "utf-8");
    const tail = src.slice(src.lastIndexOf("} catch (e) {"));
    // 🔒 `return NextResponse.json({ error: toSafeError(e) }, { status: 500 });`로 되돌아가면
    //    RDS 장애 중 응급이 다시 조용히 사라진다
    expect(tail).toMatch(/return emergencyLastResort\(e, sos\)/);
  });

  it("안전망은 DB를 치지 않는다 — prisma 호출이 없어야 한다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/chat/route.ts", "utf-8");
    const start = src.indexOf("async function emergencyLastResort(");
    const body = src.slice(start, src.indexOf("export async function POST(", start));
    expect(start).toBeGreaterThan(-1);
    // 🔒 DB가 죽어서 들어온 경로다 — 여기서 또 조회하면 같은 예외로 안전망째 무너진다
    expect(body).not.toMatch(/prisma\./);
    expect(body).toMatch(/notifyGuardian/);
    expect(body).toMatch(/detectEmergency/);
  });

  it("L3 미만은 안전망을 발동시키지 않는다 (500 유지)", async () => {
    const { detectEmergency } = await import("@/lib/chat/emergency");
    // 안전망 게이트가 쓰는 판정 자체를 고정 — 일상 발화가 L3로 새면 알림 폭주
    expect(detectEmergency("오늘 점심 뭐 먹을까요").level).toBeLessThan(3);
    expect(detectEmergency("숨이 안 쉬어져요").level).toBe(3);
  });
});

describe("세 진입점의 알림 게이트가 대칭이다", () => {
  it("live·observe 경로가 저장 실패에 알림을 묶지 않는다", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["app/api/live/turn/route.ts", "app/api/observe/turn/route.ts"]) {
      const src = await fs.readFile(f, "utf-8");
      // 🔒 `&& userMsgId` 게이트가 되살아나면 저장 실패 턴의 응급이 조용히 알림 0건이 된다
      expect(src, f).not.toMatch(/emergency\.level >= 2 && userMsgId/);
      expect(src, f).toMatch(/저장 실패[\s\S]{0,40}알림은 계속/);
    }
  });

  it("세 경로 모두 저장을 try/catch로 감싼다", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["app/api/chat/route.ts", "app/api/live/turn/route.ts", "app/api/observe/turn/route.ts"]) {
      const src = await fs.readFile(f, "utf-8");
      expect(src, f).toMatch(/let userMsgId: string \| undefined/);
    }
  });
});
