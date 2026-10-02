/**
 * 보호자 웹훅 SSRF 가드 테스트.
 *
 * 왜 지금 쓰는가 — 2026-10-02 커버리지 도입으로 드러난 사실:
 *   lib/chat/emergency-notify.ts는 분기 26.1%(30/115)였고, 미실행 블록의 가장 큰 덩어리가
 *   **SSRF 가드 전체**였다. 보호자가 입력한 URL로 서버가 POST하는 경로인데
 *   isPrivateIPv4 / isSafeWebhookUrl / sendWebhook을 지나는 테스트가 하나도 없었다.
 *
 * 왜 중요한가: 이 서버는 AWS에서 돈다. 169.254.169.254(인스턴스 메타데이터)로 가는 요청이
 *   통과하면 내부망 스캔·메타데이터 접근으로 이어진다. 가드는 있지만 **검증된 적이 없었다.**
 *
 * ⚠ 이 테스트가 보장하지 **못하는** 것(의도적 명시):
 *   가드는 dns.lookup으로 먼저 확인하고, 그 뒤 fetch가 **독립적으로 다시** 해석한다.
 *   따라서 TTL 0 레코드로 두 해석 사이에 IP를 바꾸는 DNS rebinding은 막지 못한다.
 *   (원 주석이 "DNS rebinding 방어"라고 적고 있었으나 그 패턴으로는 막히지 않는다 — 주석 정정함.)
 *   응답 본문은 호출부로 돌아가지 않아 blind SSRF이며, 공격자는 보호자 계정이어야 한다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ default: { lookup: (...a: unknown[]) => lookup(...(a as [])) } }));

const db = {
  message: { findFirst: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  expertPatient: { findMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/notify/push-fcm", () => ({ sendEmergencyPush: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock("@/lib/notify/email", () => ({
  sendEmergencyEmail: vi.fn(async () => false),
  // 전 채널 실패 시 운영자 경보 — 2026-10-02 추가된 의존성. 빠뜨리면 undefined 호출로 전 테스트가 깨진다.
  sendOpsAlert: vi.fn(async () => true),
}));
vi.mock("@/lib/crypto", () => ({ decryptPII: (s: string) => s, encryptPII: (s: string) => s }));

const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
vi.stubGlobal("fetch", fetchMock);

/** 웹훅 URL만 등록된 보호자 상태로 1건 발송 시도하고, 실제 fetch가 나갔는지 본다. */
async function tryWebhook(url: string, resolvesTo: { address: string; family: number }[] = [{ address: "93.184.216.34", family: 4 }]) {
  vi.clearAllMocks();
  db.message.findFirst.mockResolvedValue(null);
  db.message.update.mockResolvedValue({});
  db.expertPatient.findMany.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: url, guardianEmail: null, guardianName: "보호자" });
  lookup.mockResolvedValue(resolvesTo);
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as unknown as Response);

  const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
  const r = await notifyGuardian({
    // userId를 매번 다르게 — 모듈 수준 recentSends(메모리 fan-out 상한)에 걸려
    // 두 번째 케이스부터 조용히 skip되면 테스트가 거짓 통과한다.
    userId: `u-${url}-${Math.round(performance.now() * 1000)}`,
    userName: "김응급", level: 3, category: "medical_acute",
    content: "숨이 안 쉬어져", aiReply: "119", createdAt: new Date("2026-10-02T03:00:00Z"),
  });
  return { sent: r.channels.includes("webhook"), fetched: fetchMock.mock.calls.length > 0 };
}

beforeEach(() => vi.clearAllMocks());

describe("차단되어야 하는 URL", () => {
  it("http(평문) — 민감 발화를 평문 전송하면 안 된다", async () => {
    const r = await tryWebhook("http://hooks.example.com/x");
    expect(r.fetched).toBe(false);
  });

  it.each([
    ["localhost", "https://localhost/hook"],
    [".local", "https://nas.local/hook"],
    [".internal", "https://svc.internal/hook"],
  ])("내부 호스트명 %s", async (_n, url) => {
    const r = await tryWebhook(url);
    expect(r.fetched).toBe(false);
  });

  it.each([
    ["AWS 메타데이터 169.254.169.254", "169.254.169.254"],
    ["루프백 127.0.0.1", "127.0.0.1"],
    ["0.0.0.0", "0.0.0.0"],
    ["사설 10/8", "10.0.0.5"],
    ["사설 172.16/12", "172.20.1.1"],
    ["사설 192.168/16", "192.168.0.10"],
    ["CGNAT 100.64/10", "100.100.1.1"],
  ])("DNS가 %s로 해석되면 차단", async (_n, ip) => {
    const r = await tryWebhook("https://evil.example.com/hook", [{ address: ip, family: 4 }]);
    // 🔒 이게 통과하면 AWS 인스턴스 메타데이터·내부망으로 서버가 요청을 보낸다
    expect(r.fetched).toBe(false);
  });

  it.each([
    ["IPv6 루프백", "::1"],
    ["ULA fc00::/7", "fd12:3456::1"],
    ["링크로컬 fe80::", "fe80::1"],
  ])("IPv6 %s 차단", async (_n, ip) => {
    const r = await tryWebhook("https://evil.example.com/hook", [{ address: ip, family: 6 }]);
    expect(r.fetched).toBe(false);
  });

  it("IPv4-mapped IPv6(::ffff:169.254.169.254) 우회 차단", async () => {
    const r = await tryWebhook("https://evil.example.com/hook", [{ address: "::ffff:169.254.169.254", family: 6 }]);
    expect(r.fetched).toBe(false);
  });

  it("여러 A레코드 중 **하나라도** 사설이면 차단 (라운드로빈 우회)", async () => {
    const r = await tryWebhook("https://evil.example.com/hook", [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    // 🔒 첫 레코드만 보고 통과시키면 재시도 한 번으로 메타데이터에 닿는다
    expect(r.fetched).toBe(false);
  });

  it("DNS 해석 실패는 차단(fail-closed)", async () => {
    vi.clearAllMocks();
    db.message.findFirst.mockResolvedValue(null);
    db.expertPatient.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: "https://nx.example.com/h", guardianEmail: null, guardianName: null });
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    await notifyGuardian({
      userId: "u-dnsfail", userName: "김", level: 3, category: "medical_acute",
      content: "x", aiReply: "y", createdAt: new Date(),
    });
    // 🔒 발송 경로는 fail-open이지만 SSRF 가드는 반드시 fail-closed여야 한다
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("빈 A레코드 응답도 차단", async () => {
    const r = await tryWebhook("https://empty.example.com/h", []);
    expect(r.fetched).toBe(false);
  });

  it("URL 파싱 실패는 차단", async () => {
    const r = await tryWebhook("not a url at all");
    expect(r.fetched).toBe(false);
  });
});

describe("통과되어야 하는 URL (가드가 과하게 좁아지는 회귀 방지)", () => {
  it("공인 IP로 해석되는 https는 발송된다", async () => {
    const r = await tryWebhook("https://discord.com/api/webhooks/abc");
    // 🔒 이게 깨지면 보호자 웹훅 알림이 통째로 죽는다 — 과차단도 사람이 다치는 쪽이다
    expect(r.fetched).toBe(true);
    expect(r.sent).toBe(true);
  });

  it("169.254가 아닌 169.x는 통과 (대역 경계 오판 방지)", async () => {
    const r = await tryWebhook("https://ok.example.com/h", [{ address: "169.1.1.1", family: 4 }]);
    expect(r.fetched).toBe(true);
  });

  it("172.15 / 172.32는 사설이 아니므로 통과 (경계)", async () => {
    expect((await tryWebhook("https://a.example.com/h", [{ address: "172.15.0.1", family: 4 }])).fetched).toBe(true);
    expect((await tryWebhook("https://b.example.com/h", [{ address: "172.32.0.1", family: 4 }])).fetched).toBe(true);
  });

  it("100.63 / 100.128은 CGNAT 밖이므로 통과 (경계)", async () => {
    expect((await tryWebhook("https://c.example.com/h", [{ address: "100.63.0.1", family: 4 }])).fetched).toBe(true);
    expect((await tryWebhook("https://d.example.com/h", [{ address: "100.128.0.1", family: 4 }])).fetched).toBe(true);
  });
});

describe("웹훅 전송 실패가 다른 채널을 막지 않는다", () => {
  it("fetch가 throw해도 notifyGuardian은 정상 반환한다", async () => {
    vi.clearAllMocks();
    db.message.findFirst.mockResolvedValue(null);
    db.message.update.mockResolvedValue({});
    db.expertPatient.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: "https://ok.example.com/h", guardianEmail: null, guardianName: null });
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    // 🔒 여기서 예외가 새면 응급 알림 전체가 죽는다
    const r = await notifyGuardian({
      userId: "u-fetchthrow", userName: "김", level: 3, category: "medical_acute",
      content: "x", aiReply: "y", createdAt: new Date(),
    });
    expect(r.sent).toBe(false);
    expect(r.channels).not.toContain("webhook");
  });

  it("웹훅이 5xx면 채널로 집계하지 않는다", async () => {
    vi.clearAllMocks();
    db.message.findFirst.mockResolvedValue(null);
    db.expertPatient.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: "https://ok2.example.com/h", guardianEmail: null, guardianName: null });
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as unknown as Response);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const r = await notifyGuardian({
      userId: "u-5xx", userName: "김", level: 3, category: "medical_acute",
      content: "x", aiReply: "y", createdAt: new Date(),
    });
    expect(r.channels).not.toContain("webhook");
  });
});

/**
 * 리다이렉트 우회 차단 (2026-10-02 발견 — 감사도 놓친 것).
 *
 * fetch 기본값은 `follow`다. isSafeWebhookUrl을 통과한 호스트가
 * `302 Location: http://169.254.169.254/latest/meta-data/`를 돌려주면
 * **가드를 완전히 우회해** 인스턴스 메타데이터로 요청이 나간다.
 * 가드는 처음 URL만 보고, 리다이렉트 대상은 아무도 검사하지 않았다.
 * DNS rebinding보다 훨씬 쉽고 확실한 우회 경로였다.
 */
describe("리다이렉트를 따라가지 않는다", () => {
  it("fetch 호출에 redirect: manual 이 지정돼 있다", async () => {
    vi.clearAllMocks();
    db.message.findFirst.mockResolvedValue(null);
    db.message.update.mockResolvedValue({});
    db.expertPatient.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: "https://ok.example.com/h", guardianEmail: null, guardianName: null });
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as unknown as Response);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    await notifyGuardian({
      userId: "redir-opt", userName: "김", level: 3, category: "medical_acute",
      content: "x", aiReply: "y", createdAt: new Date(),
    });
    const init = fetchMock.mock.calls[0]?.[1] as unknown as { redirect?: string };
    // 🔒 follow(기본값)로 되돌아가면 302 한 번으로 메타데이터에 닿는다
    expect(init?.redirect).toBe("manual");
  });

  it("3xx 응답은 성공으로 세지 않는다", async () => {
    vi.clearAllMocks();
    db.message.findFirst.mockResolvedValue(null);
    db.expertPatient.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: "https://ok2.example.com/h", guardianEmail: null, guardianName: null });
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock.mockResolvedValue({ ok: false, status: 302 } as unknown as Response);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const r = await notifyGuardian({
      userId: "redir-3xx", userName: "김", level: 3, category: "medical_acute",
      content: "x", aiReply: "y", createdAt: new Date(),
    });
    expect(r.channels).not.toContain("webhook");
  });
});
