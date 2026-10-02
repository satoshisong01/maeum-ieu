/**
 * 보호자 연락처 **복호 실패** 경로 — crypto·prisma·email·push를 전부 갈아끼우는 전용 파일.
 *
 * 왜 또 파일을 나눴나 (2026-10-02, 세 번째):
 *   이 테스트는 `vi.resetModules()` + `vi.doMock`으로 모듈 레지스트리를 교체한다.
 *   처음엔 describe 순서로 막으려 했고(실패), 다음엔 레지스트리 조작 테스트만 한 파일에
 *   모았다(역시 실패). 한 파일에 **두 개의 서로 다른 목 체제**가 있으면, 앞 테스트가 끝난 뒤
 *   남은 비동기 작업이 resetModules 직후의 레지스트리를 실제 모듈로 다시 채워 넣는 레이스가
 *   생긴다 — 뒤 테스트의 doMock이 간헐적으로 먹지 않는다.
 *
 *   실측(2026-10-02): 같은 파일에 둘을 두면 5연속 실패 / 간헐 통과였고,
 *   목이 빗나간 순간 유닛 테스트가 **운영 RDS에 prisma.message.create를 날렸다**.
 *   간헐 레드는 더 위험하다 — 게이트가 무시되기 시작한다.
 *
 *   그래서 규칙은 "레지스트리 조작 테스트는 모아둔다"가 아니라
 *   **"목 체제 하나당 파일 하나"**다. vitest는 파일 단위로 격리하므로 레이스가 성립하지 않는다.
 *   정리용 doUnmock도 필요 없다(필요했다는 사실 자체가 경계가 잘못됐다는 신호였다).
 */
import { describe, it, expect, vi } from "vitest";

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
    const r = await notifyGuardian({
      userId: "u-decryptfail", userName: "김응급", level: 3, category: "medical_acute",
      content: "숨이 안 쉬어져", aiReply: "119에 전화해주세요",
      createdAt: new Date("2026-10-01T12:00:00Z"), messageId: undefined,
    } as Parameters<typeof notifyGuardian>[0]);
    // 🔒 복호 실패 시 "enc:…" 문자열이 수신자로 가면 안 되고, 성공으로 집계돼도 안 된다
    expect(emailSpy).not.toHaveBeenCalled();
    expect(r.channels).not.toContain("email");
  });
});
