/**
 * 게이트 스크립트를 `npm test` 안으로 들여오는 래퍼.
 *
 * 왜 필요한가 — 두 가지 모두 실제로 당한 문제다:
 *
 * 1. **측정 거짓**: safety-regression(342건)·regex-battery가 별도 tsx 프로세스로만 돌던 동안
 *    vitest 커버리지는 lib/chat/emergency.ts를 분기 23%로 보고했다. 실제로는 그 342건이
 *    훨씬 많은 분기를 지나가는데 측정에 안 잡혔다. 측정이 거짓이면 "어디가 비었는지"를
 *    그 숫자로 판단한 모든 결론이 거짓이다.
 *
 * 2. **망각**: 별도 명령은 잊힌다. 실제로 이 저장소에서 "게이트 통과"라고 보고하면서
 *    일부만 돌린 적이 있다. 하나의 명령(`npx vitest run`)에 묶이면 잊을 수가 없다.
 *
 * ⚠ 이 래퍼는 스크립트를 **대체하지 않는다**. CLI(`npx tsx scripts/safety-regression.ts`)는
 *   그대로 동작하며, 실패 케이스 이름을 콘솔에 바로 보여주므로 디버깅엔 그쪽이 낫다.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// 스크립트가 import 시점에 전수 실행되므로, 종료(process.exit) 억제 플래그를 먼저 세운다.
process.env.GATE_AS_MODULE = "1";

/** 342건 × 콘솔 한 줄씩이면 vitest 출력이 묻힌다 — 통과 라인만 삼키고 실패는 남긴다. */
const realLog = console.log;
beforeAll(() => {
  console.log = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("✗") || first.toUpperCase().includes("FAIL")) realLog(...args);
  };
});
afterAll(() => { console.log = realLog; });

describe("게이트 스크립트 (단일 명령으로 통합)", () => {
  it("safety-regression — 라이브에서 잡은 결함의 재발 0건", async () => {
    const mod = await import("../scripts/safety-regression");
    // 🔒 한 건이라도 실패하면 과거에 고친 안전망 결함이 되살아난 것이다
    expect(mod.summary.fail, "safety-regression 실패 — 위 콘솔의 ✗ 라인을 보라").toBe(0);
    // 케이스 수가 줄면 누군가 커버리지를 삭제한 것 — 수치를 바닥으로 고정한다
    //   (342 → 358: 2026-10-06 재검토 사각지대 A-11 — 유서·삶의 무의미·두통 '듯' / → 364: 직접 운전 B4 정답 후처리 잔여)
    expect(mod.summary.pass).toBeGreaterThanOrEqual(364);
  }, 60_000);

  it("regex-battery — 한국어 후처리 정규식이 정상 발화를 망가뜨리지 않는다", async () => {
    const mod = await import("../scripts/regex-battery");
    expect(mod.summary.fail, "regex-battery 실패 — 위 콘솔의 실패 라인을 보라").toBe(0);
  }, 60_000);
});
