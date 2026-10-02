/**
 * saveMessages 부분 실패 — 응급 턴의 dedup 앵커 보존. **목 체제 전용 파일.**
 *
 * 이 파일의 목 체제는 하나다: prisma(message.create만) + rag.
 *   한때 여기에 "보호자 연락처 복호 실패"(crypto·email·push까지 교체) 테스트가 같이 있었는데,
 *   목 체제가 둘이면 앞 테스트의 잔여 비동기 작업이 resetModules 직후 레지스트리를 실제 모듈로
 *   다시 채워 뒤 테스트의 doMock이 **간헐적으로** 먹지 않았다 — 그 순간 이 테스트는 운영 RDS에
 *   prisma.message.create를 날렸다(실측 2026-10-02: 5연속 실패/간헐 통과).
 *   지금은 __tests__/emergency-notify-decrypt.test.ts로 분리했다. 규칙은 **목 체제 하나당 파일 하나.**
 */
import { describe, it, expect, vi } from "vitest";

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
