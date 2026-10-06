/**
 * 상시 감시 기록의 **범위** — 대화를 읽는 곳은 모두 관찰 기록을 걸러야 한다.
 *
 * 결함(2026-10-06): 표지 `[관찰]`이 소비처마다 리터럴로 흩어져 4곳 중 2곳만 걸렀다.
 *   일일 한도·대화 요약·Live 인지 분석 이력이 혼잣말 조각을 대화로 취급했다.
 *   → lib/chat/observation.ts로 단일화. 이 파일은 (1) 요약 트리거의 실제 SQL과
 *     (2) 표지 리터럴이 모듈 밖에 다시 생기지 않는지를 고정한다.
 *
 * 목 체제: prisma.$queryRawUnsafe 하나(호출 인자 포착). 요약 LLM은 임계치 미달로 호출되지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const rawCalls: { sql: string; args: unknown[] }[] = [];
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => { rawCalls.push({ sql, args }); return []; }),
  },
}));
vi.mock("@/lib/chat/summarizer", () => ({ summarizeMessages: vi.fn(), rollupSummaries: vi.fn() }));

const { maybeTriggerSummaryRollup } = await import("@/lib/chat/summary-trigger");
const obs = await import("@/lib/chat/observation");

beforeEach(() => { rawCalls.length = 0; });

describe("표지 헬퍼", () => {
  it("쓰는 쪽과 읽는 쪽이 같은 규칙이다", () => {
    const stored = obs.toObservationContent("숨이 차네");
    expect(obs.isObservationContent(stored)).toBe(true);
    expect(obs.isObservationContent("숨이 차네")).toBe(false);
    expect(obs.isObservationContent(null)).toBe(false);
    expect(obs.EXCLUDE_OBSERVATION).toEqual({ NOT: { content: { startsWith: obs.OBSERVATION_PREFIX } } });
  });
});

describe("대화 요약 — 혼잣말은 요약되지 않는다", () => {
  it("요약 대상 메시지 조회가 관찰 기록을 뺀다 (표지는 매개변수로)", async () => {
    await maybeTriggerSummaryRollup({ userId: "u-1", conversationId: "c-1" });
    const msgQuery = rawCalls.find((c) => /FROM "Message"/.test(c.sql));
    expect(msgQuery, "요약 트리거가 메시지를 조회하지 않았다").toBeTruthy();
    // 🔒 2026-10-06 이전: 혼잣말이 "지난 대화 요약"이 되어 동반자 프롬프트의 기억으로 들어갔다
    expect(msgQuery!.sql).toMatch(/content NOT LIKE \$3/);
    expect(msgQuery!.args[2]).toBe(`${obs.OBSERVATION_PREFIX}%`);
  });
});

describe("표지 리터럴은 lib/chat/observation.ts에만 (F3)", () => {
  /** app/·lib/의 .ts/.tsx를 전부 모은다 */
  async function walk(dir: string, out: string[] = []): Promise<string[]> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== "node_modules" && !ent.name.startsWith(".")) await walk(full, out); }
      else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
    }
    return out;
  }

  /**
   * ⚠ 타임아웃을 명시한다. 처음엔 파일을 하나씩 순차로 읽어, 커버리지 계측 + 병렬 실행 부하에서
   *   기본 5초를 넘겨 **간헐적으로** 실패했다(5회 중 1~2회). 간헐 레드는 게이트를 무시하게 만든다 —
   *   이 세션에서 그걸로 이미 한 번 당했다. 읽기를 병렬로 바꾸고 여유를 둔다.
   */
  it("코드(주석 제외)에 `[관찰]` 리터럴이 모듈 밖에 없다", async () => {
    const files = [...await walk("app"), ...await walk("lib")]
      .filter((f) => !f.replace(/\\/g, "/").endsWith("lib/chat/observation.ts"));
    const contents = await Promise.all(files.map((f) => readFile(f, "utf-8")));
    const offenders: string[] = [];
    contents.forEach((text, fi) => {
      text.split(/\r?\n/).forEach((l, i) => {
        if (/^\s*\*/.test(l)) return;              // JSDoc 본문
        const code = l.replace(/\/\/.*$/, "");
        if (code.includes("[관찰]")) offenders.push(`${files[fi]}:${i + 1}`);
      });
    });
    // 🔒 새 소비처가 리터럴로 직접 비교하기 시작하면, 다음 소비처는 거르는 걸 잊는다
    expect(offenders, `표지는 lib/chat/observation의 헬퍼로만: ${offenders.join(", ")}`).toEqual([]);
  }, 30_000);
});
