/**
 * 모듈 레지스트리를 갈아끼우는(vi.resetModules + vi.doMock) 테스트 **전용 파일**.
 *
 * 왜 파일을 나눴나 (2026-10-02, 두 번 당하고 나서):
 *   같은 파일 안에서 resetModules를 쓰면 **그 뒤에 오는 모든 describe가 오염된다** —
 *   여기서 끼운 축소판 prisma 스텁을 집어 user.findUnique가 없어 조회가 throw하고,
 *   결과가 "발송 0건"이 되어 뒤 테스트가 거짓 실패한다. 실제로 두 번 겪었다.
 *   describe 순서를 지키는 것으로 막으려 했으나, 새 테스트를 **파일 끝에 덧붙이는 순간**
 *   다시 깨진다(사람의 기억에 의존하는 규칙은 지켜지지 않는다).
 *   vitest는 **파일 단위로 격리**하므로, 파일을 나누면 순서 자체가 무의미해진다.
 */
import { describe, it, expect, vi } from "vitest";

const P = {
  userId: "u1", userName: "김응급", level: 3 as const, category: "medical_acute",
  content: "숨이 안 쉬어져", aiReply: "119에 전화해주세요", createdAt: new Date("2026-10-01T12:00:00Z"),
};

describe("보호자 연락처 복호 실패", () => {
  it("보호자 이메일이 복호 실패(빈 문자열)면 이메일 채널을 세지 않는다", async () => {
    vi.resetModules();
    vi.doMock("@/lib/crypto", () => ({ decryptPII: () => "", encryptPII: (s: string) => s }));
    vi.doMock("@/lib/prisma", () => ({ prisma: {
      message: { findFirst: async () => null, update: async () => ({}) },
      user: { findUnique: async () => ({ guardianWebhookUrl: null, guardianEmail: "enc:broken", guardianName: null }) },
      expertPatient: { findMany: async () => [] },
    } }));
    vi.doMock("@/lib/notify/push-fcm", () => ({ sendEmergencyPush: async () => ({ sent: 0, failed: 0 }) }));
    const emailSpy = vi.fn(async () => true);
    vi.doMock("@/lib/notify/email", () => ({ sendEmergencyEmail: emailSpy, sendOpsAlert: async () => true }));
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const r = await notifyGuardian({ ...P, userId: "u-decryptfail", messageId: undefined } as Parameters<typeof notifyGuardian>[0]);
    // 🔒 복호 실패 시 "enc:…" 문자열이 수신자로 가면 안 되고, 성공으로 집계돼도 안 된다
    expect(emailSpy).not.toHaveBeenCalled();
    expect(r.channels).not.toContain("email");
    vi.doUnmock("@/lib/crypto");
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/lib/notify/push-fcm");
    vi.doUnmock("@/lib/notify/email");
    vi.resetModules();
  });
});

describe("saveMessages 부분 실패 — 응급 턴의 dedup 앵커 보존", () => {
  /**
   * ⚠ 이 describe는 vi.resetModules() + vi.doMock으로 **모듈 레지스트리를 갈아끼운다.**
   *   정리하지 않으면 이후 describe가 `@/lib/chat/emergency-notify`를 import할 때
   *   여기서 끼운 축소판 prisma 스텁(message.create만 있음)을 집어, user.findUnique가 없어
   *   조회가 throw → lookupFailed → "발송 0건"이 된다.
   *   실제로 2026-10-02에 뒤에 추가한 운영자 경보 테스트가 이 누수로 거짓 실패했다.
   *   테스트 간 상태 누수는 결과를 **순서에 의존하게** 만들어, 거짓 실패와 거짓 통과를 둘 다 낳는다.
   */
  // (이전에 있던 afterAll 정리는 제거했다 — 파일을 분리한 지금은 vitest가 파일 단위로
  //  격리하므로 이 파일의 레지스트리 조작이 다른 파일에 새지 않는다.)

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

/**
 * L2(주의) 경로 — 2026-10-02 커버리지 측정에서 **전부 미실행**이었다.
 * 지금까지 이 파일은 L3만 검증하고 있었는데, 실서비스에서 L2가 더 자주 발생한다
 * (가슴 답답·어지러움·낙상 호소 등). L3 문구가 L2에 새면 보호자가 과잉 반응하고,
 * 반대로 L2가 "관찰"로 표시되면 안부 확인 자체를 안 하게 된다.
 */
