/**
 * 일일 대화량 제한 — 라이브 통합 검증(실제 DB + 실제 /api/chat 핸들러).
 *
 * 성격: 통합 테스트(그레이박스 — 세션만 주입, prisma·프롬프트 빌드·정규식은 실제 코드)
 *       + 인수 테스트(어르신이 실제로 보게 되는 응답을 그대로 확인)
 *
 * 왜 따로 두는가: 실제 RDS에 붙고 테스트 계정 데이터를 쓰므로 CI에서 돌릴 수 없다.
 *   기본은 건너뛰고, 로컬에서 플래그를 켤 때만 실행한다:
 *     LIVE_DB_TEST=1 npx vitest run __tests__/daily-limit.live.test.ts
 *
 * 안전장치: 보호자 알림(푸시·이메일) 모듈을 모킹한다 — 실제 연동된 보호자에게
 *   테스트 발화로 위급 알림이 나가지 않게. LLM 호출은 이 테스트 경로에 없다
 *   (한도 차단 응답과 응급 L3 응답은 모두 템플릿).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const LIVE = process.env.LIVE_DB_TEST === "1";
const ELDER_EMAIL = "convtest@maeum.test";

// ── 세션 주입 ──
let currentSession: { user: { id: string; name?: string; screeningMode: string } } | null = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => currentSession) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

// ── 알림은 절대 밖으로 내보내지 않는다(호출 여부만 기록) ──
const pushCalls: unknown[][] = [];
const mailCalls: unknown[][] = [];
vi.mock("@/lib/notify/push-fcm", () => ({
  sendEmergencyPush: vi.fn(async (...a: unknown[]) => { pushCalls.push(a); return { sent: 0, failed: 0, skipped: true }; }),
  registerToken: vi.fn(async () => true),
}));
vi.mock("@/lib/notify/email", () => ({
  sendEmergencyEmail: vi.fn(async (...a: unknown[]) => { mailCalls.push(a); return true; }),
}));

interface Ctx { elderId: string; conversationId: string }
let ctx: Ctx;

/** KST 자정 이후 사용자 발화 수를 매번 새로 센다 — 테스트가 턴을 저장하므로 캐시하면 틀린다 */
async function usedToday(): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const gte = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600 * 1000);
  return prisma.message.count({ where: { conversationId: ctx.conversationId, role: "user", createdAt: { gte } } });
}

/** 라우트를 env 반영 상태로 새로 import — DAILY_TURN_LIMIT은 모듈 로드 시 1회 평가된다 */
async function postChat(limit: number, body: Record<string, unknown>) {
  process.env.DAILY_TURN_LIMIT = String(limit);
  vi.resetModules();
  const mod = await import("@/app/api/chat/route");
  const res = await mod.POST(new Request("http://t/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
}

/** .env 로드 — vitest는 Next의 env 주입을 받지 않는다(setup 파일 없이 자급) */
async function loadEnv() {
  const raw = await (await import("node:fs/promises")).readFile(".env", "utf-8").catch(() => "");
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
}

beforeAll(async () => {
  if (!LIVE) return;
  await loadEnv();
  const { prisma } = await import("@/lib/prisma");
  const elder = await prisma.user.findUnique({
    where: { email: ELDER_EMAIL },
    select: { id: true, name: true, screeningMode: true, consentedAt: true },
  });
  if (!elder) throw new Error(`테스트 계정 없음: ${ELDER_EMAIL} — scripts/chat-turn.ts --reset 로 생성`);
  if (!elder.consentedAt) throw new Error("테스트 계정 동의 미설정 — 동의 게이트에서 403이 난다");

  const conv = await prisma.conversation.findFirst({
    where: { userId: elder.id }, orderBy: { createdAt: "desc" }, select: { id: true },
  });
  if (!conv) throw new Error("테스트 대화 없음 — scripts/chat-turn.ts --reset 로 생성");

  ctx = { elderId: elder.id, conversationId: conv.id };
  currentSession = { user: { id: elder.id, name: elder.name ?? "테스트", screeningMode: "user" } };

  // '한도 도달' 상태를 만들려면 오늘 발화가 최소 1건 있어야 한다(상한 0은 제한 해제를 뜻함).
  if ((await usedToday()) === 0) {
    await prisma.message.create({
      data: { conversationId: conv.id, role: "user", content: "(한도 테스트 시드 발화)" },
    });
    console.log("[live] 시드 발화 1건 생성 — 오늘 사용량 0이면 한도 도달을 만들 수 없다");
  }
  console.log(`[live] elder=${elder.id.slice(0, 8)} conv=${conv.id.slice(0, 8)} 오늘 사용=${await usedToday()}턴`);
}, 60_000);

describe.skipIf(!LIVE)("한도 도달 — 실제 라우트 응답", () => {
  it("상한을 채운 상태의 일상 발화는 마무리 인사로 닫힌다 (LLM 호출 없음)", async () => {
    const limit = await usedToday(); // used === limit → 도달
    const r = await postChat(limit, {
      conversationId: ctx.conversationId,
      messages: [{ role: "user", content: "오늘 날씨가 참 좋더라고" }],
    });
    expect(r.status).toBe(200);
    expect(r.json?.dailyLimitReached).toBe(true);
    const text = String(r.json?.text ?? "");
    console.log("[live] 차단 응답:", text);
    expect(text).toContain("내일");
    for (const bad of ["제한", "초과", "불가", "한도", "오류"]) expect(text).not.toContain(bad);
  }, 60_000);

  it("차단된 턴도 기록된다 — 사용량이 멈추면 상한이 의미를 잃는다", async () => {
    const before = await usedToday();
    await postChat(before, {
      conversationId: ctx.conversationId,
      messages: [{ role: "user", content: "그래도 한마디만 더 하자" }],
    });
    expect(await usedToday()).toBe(before + 1);
  }, 60_000);

  it("상한을 채웠어도 응급 발화는 통과해 L3로 처리된다 — 안전이 비용보다 우선", async () => {
    const limit = await usedToday();
    const r = await postChat(limit, {
      conversationId: ctx.conversationId,
      messages: [{ role: "user", content: "숨이 안 쉬어지고 가슴이 너무 아파" }],
    });
    expect(r.status).toBe(200);
    expect(r.json?.dailyLimitReached).toBeUndefined(); // 🔒 마무리 인사로 덮이면 응급이 사라진다
    const text = String(r.json?.text ?? "");
    console.log("[live] 응급 응답:", text.slice(0, 90));
    expect(text).toMatch(/119/);
  }, 60_000);

  it("상한이 넉넉하면 제한 응답이 나오지 않는다", async () => {
    // LLM을 타지 않도록 시간 질문(템플릿 즉답 경로)으로 확인한다
    const r = await postChat((await usedToday()) + 50, {
      conversationId: ctx.conversationId,
      messages: [{ role: "user", content: "지금 몇 시야?" }],
    });
    expect(r.status).toBe(200);
    expect(r.json?.dailyLimitReached).toBeUndefined();
    console.log("[live] 통과 응답:", String(r.json?.text ?? "").slice(0, 60));
  }, 60_000);

  it("인사 턴은 상한과 무관하게 통과한다 — 앱을 열자마자 막히면 고장으로 오해한다", async () => {
    const r = await postChat(await usedToday(), {
      conversationId: ctx.conversationId,
      isInitialGreeting: true,
      messages: [],
    });
    // 인사는 스트리밍/텍스트 경로를 타므로 '제한 응답이 아님'만 확인한다
    expect(r.json?.dailyLimitReached).toBeUndefined();
  }, 60_000);

  it("보호자 알림은 테스트 중 외부로 나가지 않았다", () => {
    // 응급 턴에서 notifyGuardian이 돌았다면 모킹된 함수로 들어왔어야 한다
    console.log(`[live] push=${pushCalls.length} mail=${mailCalls.length} (모킹 — 실제 발송 0)`);
    expect(true).toBe(true);
  });
});

describe.skipIf(LIVE)("라이브 검증 스킵", () => {
  it("LIVE_DB_TEST=1 일 때만 실행된다", () => {
    expect(process.env.LIVE_DB_TEST).not.toBe("1");
  });
});
