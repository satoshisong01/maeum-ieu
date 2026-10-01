/**
 * 구독 권리·상태 매핑 테스트.
 *
 * 성격: 단위 테스트(화이트박스) + 계약 테스트(안전 경로가 과금과 분리됨을 소스에서 고정)
 *
 * 왜 꼼꼼히 하나: 돈이 걸린 판정은 양방향으로 모두 위험하다. 느슨하면 결제 없이 혜택이
 *   새고(비용), 엄하면 결제한 사람이 혜택을 못 받는다(신뢰). 특히 **해지 예약·결제 유예**는
 *   "혜택 유지"가 맞고 **만료·보류**는 "종료"가 맞다 — 이 경계를 코드가 아니라 테스트로 고정한다.
 *
 * 🔒 절대 조건: 응급 감지·위급 알림은 구독과 무관해야 한다. 돈을 내지 않아 119 안내가
 *   막히는 설계는 허용하지 않는다(아래 '안전 경로 분리' describe).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── prisma 스텁 ──
interface SubRow { productId: string; expiresAt: Date | null; beneficiaryUserId: string; purchaserUserId: string }
let subRows: SubRow[] = [];
let subThrows = false;
let lastSubWhere: Record<string, unknown> | null = null;
let links: { expertUserId: string; patientUserId: string; status: string; createdAt: Date }[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscription: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        lastSubWhere = args?.where ?? null;
        if (subThrows) throw new Error("db down");
        return subRows;
      }),
    },
    expertPatient: {
      findUnique: vi.fn(async ({ where }: { where: { expertUserId_patientUserId: { expertUserId: string; patientUserId: string } } }) => {
        const k = where.expertUserId_patientUserId;
        return links.find((l) => l.expertUserId === k.expertUserId && l.patientUserId === k.patientUserId) ?? null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { expertUserId: string; status: string } }) => {
        const found = links
          .filter((l) => l.expertUserId === where.expertUserId && l.status === where.status)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        return found ? { patientUserId: found.patientUserId } : null;
      }),
    },
    message: { count: vi.fn(async () => 0) },
  },
}));

const ENV_KEYS = ["DAILY_TURN_LIMIT", "PRO_DAILY_TURN_LIMIT", "BILLING_PRO_PRODUCT_IDS", "BILLING_ENFORCE", "PLAY_PACKAGE_NAME", "PLAY_SERVICE_ACCOUNT_JSON"] as const;
const saved: Record<string, string | undefined> = {};

async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return {
    ent: await import("@/lib/billing/entitlement"),
    plans: await import("@/lib/billing/plans"),
    play: await import("@/lib/billing/play-api"),
    usage: await import("@/lib/usage/daily-limit"),
  };
}

const future = () => new Date(Date.now() + 30 * 86400_000);
const past = () => new Date(Date.now() - 86400_000);

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  subRows = []; subThrows = false; lastSubWhere = null; links = [];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("Play 상태 → 우리 상태 매핑", () => {
  it("해지 예약·결제 유예는 혜택을 유지한다 — 이미 낸 돈에 대한 권리", async () => {
    const { play, plans } = await load();
    expect(play.mapState("SUBSCRIPTION_STATE_ACTIVE", false)).toBe("canceled"); // 자동갱신 끔 = 해지 예약
    expect(play.mapState("SUBSCRIPTION_STATE_CANCELED", false)).toBe("canceled");
    expect(play.mapState("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", true)).toBe("grace");
    for (const s of ["canceled", "grace", "active"]) {
      expect(plans.ENTITLED_STATUSES).toContain(s);
    }
  });

  it("보류·일시정지·만료는 혜택이 끝난다", async () => {
    const { play, plans } = await load();
    expect(play.mapState("SUBSCRIPTION_STATE_ON_HOLD", true)).toBe("on_hold");
    expect(play.mapState("SUBSCRIPTION_STATE_PAUSED", true)).toBe("paused");
    expect(play.mapState("SUBSCRIPTION_STATE_EXPIRED", false)).toBe("expired");
    expect(play.mapState("SUBSCRIPTION_STATE_PENDING", true)).toBe("pending"); // 지연 결제 — 아직 돈이 안 들어왔다
    for (const s of ["on_hold", "paused", "expired", "pending", "revoked"]) {
      expect(plans.ENTITLED_STATUSES).not.toContain(s);
    }
  });

  it("모르는 상태는 혜택 없음으로 떨어진다 — 새 상태값이 생겨도 공짜가 되지 않게", async () => {
    const { play, plans } = await load();
    const mapped = play.mapState("SUBSCRIPTION_STATE_SOMETHING_NEW", true);
    expect(plans.ENTITLED_STATUSES).not.toContain(mapped);
  });

  it("활성 + 자동갱신은 active", async () => {
    const { play } = await load();
    expect(play.mapState("SUBSCRIPTION_STATE_ACTIVE", true)).toBe("active");
  });
});

describe("권리 판정", () => {
  it("구독이 없으면 무료 티어", async () => {
    const { ent } = await load({ DAILY_TURN_LIMIT: "100" });
    const e = await ent.getEntitlement("elder-1");
    expect(e.tier).toBe("free");
    expect(e.dailyTurnLimit).toBe(100);
    expect(e.guardianFeatures).toBe(false);
  });

  it("혜택 대상(어르신)이면 유료 티어 — 보호자가 결제한 구독", async () => {
    subRows = [{ productId: "sub_monthly", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "guardian-1" }];
    const { ent } = await load({ DAILY_TURN_LIMIT: "100", PRO_DAILY_TURN_LIMIT: "300" });
    const e = await ent.getEntitlement("elder-1");
    expect(e.tier).toBe("pro");
    expect(e.dailyTurnLimit).toBe(300);
    expect(e.source).toBe("beneficiary");
  });

  it("결제자(보호자)도 같은 구독으로 유료 기능이 열린다", async () => {
    subRows = [{ productId: "sub_monthly", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "guardian-1" }];
    const { ent } = await load();
    const e = await ent.getEntitlement("guardian-1");
    expect(e.tier).toBe("pro");
    expect(e.guardianFeatures).toBe(true);
    expect(e.source).toBe("purchaser");
  });

  it("만료 시각이 지난 구독은 상태가 active여도 무료 — RTDN 지연 시 혜택이 새지 않게", async () => {
    subRows = [{ productId: "sub_monthly", expiresAt: past(), beneficiaryUserId: "elder-1", purchaserUserId: "guardian-1" }];
    const { ent } = await load();
    expect((await ent.getEntitlement("elder-1")).tier).toBe("free");
  });

  it("조회 자체가 혜택 상태만 가져온다 — 만료·취소된 구독을 세지 않는다", async () => {
    const { ent } = await load();
    await ent.getEntitlement("elder-1");
    const w = lastSubWhere as { status?: { in?: string[] }; revokedAt?: unknown } | null;
    expect(w?.status?.in).toEqual(expect.arrayContaining(["active", "grace", "canceled"]));
    expect(w?.status?.in).not.toContain("expired");
    expect(w?.revokedAt).toBeNull(); // 🔒 환불된 구독은 제외
  });

  it("등록되지 않은 상품 ID는 유료로 인정하지 않는다", async () => {
    subRows = [{ productId: "sub_other", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "elder-1" }];
    const { ent } = await load({ BILLING_PRO_PRODUCT_IDS: "sub_monthly,sub_yearly" });
    expect((await ent.getEntitlement("elder-1")).tier).toBe("free");
  });

  it("상품 ID 목록이 비어 있으면 모든 구독을 유료로 인정한다 — 가격 미확정 단계", async () => {
    subRows = [{ productId: "anything", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "elder-1" }];
    const { ent } = await load();
    expect((await ent.getEntitlement("elder-1")).tier).toBe("pro");
  });

  it("조회 실패는 무료 티어로 떨어진다 — 과금 장치 장애가 서비스 중단이 되지 않게", async () => {
    subThrows = true;
    const { ent } = await load({ DAILY_TURN_LIMIT: "100" });
    const e = await ent.getEntitlement("elder-1");
    expect(e.tier).toBe("free");
    expect(e.dailyTurnLimit).toBe(100);
  });

  it("빈 userId는 조회 없이 무료", async () => {
    const { ent } = await load();
    expect((await ent.getEntitlement("")).tier).toBe("free");
    expect(lastSubWhere).toBeNull();
  });

  it("유료 상한 미설정 시 무료 상한의 3배", async () => {
    subRows = [{ productId: "p", expiresAt: future(), beneficiaryUserId: "e", purchaserUserId: "e" }];
    const { ent } = await load({ DAILY_TURN_LIMIT: "50" });
    expect((await ent.getEntitlement("e")).dailyTurnLimit).toBe(150);
  });
});

describe("혜택 대상 결정 — 남의 계정에 붙지 않게", () => {
  it("연결된 어르신이 혜택 대상이 된다", async () => {
    links = [{ expertUserId: "guardian-1", patientUserId: "elder-1", status: "active", createdAt: new Date(1) }];
    const { ent } = await load();
    expect(await ent.resolveBeneficiary("guardian-1")).toBe("elder-1");
  });

  it("여러 명이면 가장 먼저 연결된 어르신", async () => {
    links = [
      { expertUserId: "g", patientUserId: "elder-late", status: "active", createdAt: new Date(2000) },
      { expertUserId: "g", patientUserId: "elder-first", status: "active", createdAt: new Date(1000) },
    ];
    const { ent } = await load();
    expect(await ent.resolveBeneficiary("g")).toBe("elder-first");
  });

  it("미연결 대상을 요청하면 무시한다 — 임의 계정에 혜택을 붙일 수 없다", async () => {
    links = [{ expertUserId: "g", patientUserId: "mine", status: "active", createdAt: new Date(1) }];
    const { ent } = await load();
    expect(await ent.resolveBeneficiary("g", "someone-elses-elder")).toBe("mine");
  });

  it("해지된(revoked) 연결은 대상이 되지 않는다", async () => {
    links = [{ expertUserId: "g", patientUserId: "elder-1", status: "revoked", createdAt: new Date(1) }];
    const { ent } = await load();
    expect(await ent.resolveBeneficiary("g", "elder-1")).toBe("g"); // 본인에게 적용
  });

  it("연결이 없으면 결제자 본인이 대상 — 어르신 계정이 직접 결제한 경우", async () => {
    const { ent } = await load();
    expect(await ent.resolveBeneficiary("elder-self")).toBe("elder-self");
  });
});

describe("일일 상한과의 연동", () => {
  it("무료 여유가 충분하면 구독을 조회하지 않는다 — 평상시 턴에 쿼리를 더하지 않게", async () => {
    const { usage } = await load({ DAILY_TURN_LIMIT: "100" });
    await usage.getDailyUsage("conv-1", "elder-1");
    expect(lastSubWhere).toBeNull();
  });

  it("무료 상한 근처에서는 구독을 조회해 상한을 올린다", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma.message.count as unknown as { mockImplementation: (f: () => Promise<number>) => void })
      .mockImplementation(async () => 100);
    subRows = [{ productId: "p", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "g" }];
    const { usage } = await load({ DAILY_TURN_LIMIT: "100", PRO_DAILY_TURN_LIMIT: "300" });
    const u = await usage.getDailyUsage("conv-1", "elder-1");
    expect(lastSubWhere).not.toBeNull();
    expect(u.limit).toBe(300);
    expect(u.exceeded).toBe(false);
  });

  it("userId 없이 호출하면 무료 상한만 적용된다", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma.message.count as unknown as { mockImplementation: (f: () => Promise<number>) => void })
      .mockImplementation(async () => 100);
    const { usage } = await load({ DAILY_TURN_LIMIT: "100" });
    const u = await usage.getDailyUsage("conv-1");
    expect(u.exceeded).toBe(true);
    expect(lastSubWhere).toBeNull();
  });
});

describe("Play 설정 가드", () => {
  it("설정이 없으면 검증 불가로 판단한다 — 검증 없는 권리 부여 금지", async () => {
    const { play } = await load();
    expect(play.isPlayConfigured()).toBe(false);
  });

  it("패키지명만 있고 서비스 계정이 없으면 미설정", async () => {
    const { play } = await load({ PLAY_PACKAGE_NAME: "com.maeumapp" });
    expect(play.isPlayConfigured()).toBe(false);
  });

  it("서비스 계정 JSON이 깨져 있으면 미설정으로 처리한다(크래시 금지)", async () => {
    const { play } = await load({ PLAY_PACKAGE_NAME: "com.maeumapp", PLAY_SERVICE_ACCOUNT_JSON: "{not json" });
    expect(play.isPlayConfigured()).toBe(false);
  });

  it("base64로 넣은 서비스 계정도 인식한다", async () => {
    const sa = Buffer.from(JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN-----" })).toString("base64");
    const { play } = await load({ PLAY_PACKAGE_NAME: "com.maeumapp", PLAY_SERVICE_ACCOUNT_JSON: sa });
    expect(play.isPlayConfigured()).toBe(true);
  });
});

describe("안전 경로 분리 — 과금이 안전을 막지 않는다", () => {
  let src = "";
  beforeEach(async () => {
    if (!src) src = await (await import("node:fs/promises")).readFile("app/api/expert/patients/[id]/route.ts", "utf-8");
  });

  it("보호자 구독 게이트에서도 위급 이력은 그대로 내보낸다", () => {
    const gate = src.slice(src.indexOf("BILLING_ENFORCE &&"));
    const block = gate.slice(0, gate.indexOf("return NextResponse.json", gate.indexOf("return NextResponse.json") + 10) + 1200);
    expect(block).toContain("emergencyLevel: { gte: 2 }"); // 🔒 위급 건수는 조회한다
    expect(block).toMatch(/emergency:\s*\{\s*count/);       // 🔒 응답에도 담는다
  });

  it("기본값은 미적용 — 가격 확정 전에 아무것도 막지 않는다", async () => {
    const { plans } = await load();
    expect(plans.BILLING_ENFORCE).toBe(false);
  });

  it("BILLING_ENFORCE=1에서만 게이트가 켜진다", async () => {
    const { plans } = await load({ BILLING_ENFORCE: "1" });
    expect(plans.BILLING_ENFORCE).toBe(true);
  });

  it("응급·알림 모듈은 구독을 참조하지 않는다", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["lib/chat/emergency.ts", "lib/chat/emergency-notify.ts", "lib/notify/push-fcm.ts", "lib/notify/email.ts"]) {
      const s = await fs.readFile(f, "utf-8");
      expect(s).not.toMatch(/entitlement|subscription|BILLING_ENFORCE/i);
    }
  });

  it("일일 상한 게이트는 응급 발화를 통과시킨다(구독과 무관)", async () => {
    const s = await (await import("node:fs/promises")).readFile("app/api/chat/route.ts", "utf-8");
    const gate = s.slice(s.indexOf("let nearLimitRemaining"), s.indexOf("const historyText = buildHistoryText"));
    expect(gate).toMatch(/isEmergencyUtterance/);
    expect(gate).not.toMatch(/entitlement|subscription/i);
  });
});
