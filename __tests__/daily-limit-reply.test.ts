/**
 * buildDailyLimitReplyForUser — 한도 안내 문구의 **호칭·동반자 이름**이 경로마다 같아야 한다.
 *
 * 왜: Live는 목소리로 들린다. /api/live/token(세션 시작 차단)과 /api/live/turn(세션 중 도달)이
 *   각자 호칭을 유도하면, 같은 어르신이 같은 날 "할머니"와 "선생님"으로 번갈아 불린다.
 *   2026-10-06 이전엔 토큰 경로에 유도 로직이 인라인으로 복사돼 있었다 — 그걸 이 헬퍼로 올렸다.
 *
 * 목 체제: prisma.user.findUnique 하나. 호칭 규칙(getHonorific)은 **실제 코드**를 쓴다
 *   — 그 규칙과 같은지가 이 테스트의 질문이기 때문이다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let row: Record<string, unknown> | null | Error = null;
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => { if (row instanceof Error) throw row; return row; }),
    },
  },
}));

const { buildDailyLimitReplyForUser } = await import("@/lib/usage/daily-limit");
const { getHonorific } = await import("@/lib/chat/prompt");
const { COMPANION_DEFAULTS } = await import("@/lib/chat/constants");

beforeEach(() => { row = null; });

describe("호칭 — /api/chat과 같은 규칙", () => {
  it("직접 정한 호칭(userHonorific)이 최우선이다", async () => {
    row = { name: "김순자", age: 80, gender: "female", userHonorific: "순자 언니", companionName: "민지" };
    expect(await buildDailyLimitReplyForUser("u")).toMatch(/^순자 언니,/);
  });

  it("호칭이 없으면 나이·성별로 유도한다 (getHonorific과 동일)", async () => {
    row = { name: "김순자", age: 80, gender: "female", userHonorific: null, companionName: "민지" };
    const expected = getHonorific(80, "female");
    expect(expected).toBe("할머니");   // 규칙 자체가 바뀌면 여기서 먼저 알 수 있게
    expect(await buildDailyLimitReplyForUser("u")).toMatch(new RegExp(`^${expected},`));
  });

  it("유도 결과가 '선생님'이고 이름이 있으면 '이름님'으로 부른다", async () => {
    row = { name: "박철수", age: null, gender: null, userHonorific: "", companionName: "민지" };
    expect(await buildDailyLimitReplyForUser("u")).toMatch(/^박철수님,/);
  });

  it("공백뿐인 호칭은 없는 것으로 본다", async () => {
    row = { name: "김순자", age: 80, gender: "female", userHonorific: "   ", companionName: "민지" };
    expect(await buildDailyLimitReplyForUser("u")).toMatch(/^할머니,/);
  });
});

describe("동반자 이름", () => {
  it("설정한 동반자 이름을 쓴다", async () => {
    row = { name: "김순자", age: 80, gender: "female", userHonorific: null, companionName: "손주" };
    expect(await buildDailyLimitReplyForUser("u")).toContain("손주");
  });

  it("없으면 기본 동반자 이름으로", async () => {
    row = { name: "김순자", age: 80, gender: "female", userHonorific: null, companionName: null };
    expect(await buildDailyLimitReplyForUser("u")).toContain(COMPANION_DEFAULTS.name);
  });
});

describe("실패 모드 — 안내를 못 하는 것보다 기본 호칭이 낫다", () => {
  it("DB 조회가 throw해도 문장을 돌려준다", async () => {
    row = new Error("db down");
    const text = await buildDailyLimitReplyForUser("u");
    // 🔒 여기서 throw하면 토큰 경로는 502, 턴 경로는 500이 되어 어르신이 고장으로 오해한다
    expect(text).toMatch(/^선생님,/);
    expect(text).toContain(COMPANION_DEFAULTS.name);
    expect(text).toContain("내일");
  });

  it("사용자가 없어도 문장을 돌려준다", async () => {
    row = null;
    expect(await buildDailyLimitReplyForUser("u")).toMatch(/^선생님,/);
  });
});

describe("호칭 규칙은 한 곳에만 (2026-10-06 재검토)", () => {
  it("resolveHonorific — 명시 > 유도 > (선생님이면) 이름님", async () => {
    const { resolveHonorific } = await import("@/lib/chat/prompt");
    expect(resolveHonorific({ name: "김순자", age: 80, gender: "female", userHonorific: "순자 언니" })).toBe("순자 언니");
    expect(resolveHonorific({ name: "김순자", age: 80, gender: "female", userHonorific: "  " })).toBe("할머니");
    expect(resolveHonorific({ name: "박철수", age: null, gender: null })).toBe("박철수님");
    expect(resolveHonorific({ name: " ", age: null, gender: null })).toBe("선생님");
    expect(resolveHonorific(null)).toBe("선생님");
  });

  it("동반자 프롬프트·한도 인사·복약 알림이 모두 그 함수를 쓰고, 규칙 복사본이 없다", async () => {
    const { readFile } = await import("node:fs/promises");
    const sites = ["lib/chat/prompt.ts", "lib/usage/daily-limit.ts", "app/api/medications/trigger/route.ts"];
    for (const f of sites) {
      const src = await readFile(f, "utf-8");
      expect(src, `${f}는 resolveHonorific을 써야 한다`).toMatch(/resolveHonorific\(/);
    }
    // 🔒 "선생님이면 이름님" 조합을 다시 인라인으로 쓰면 그 복사본은 언젠가 어긋난다(복약 알림이 그랬다)
    for (const f of sites.slice(1)) {
      const src = await readFile(f, "utf-8");
      expect(src, `${f}에 호칭 규칙 복사본`).not.toMatch(/=== "선생님"/);
    }
  });
});
