/**
 * 상시 감시 조각 대기열 — "처리 중에 들어온 발화를 버리지 않는다"를 고정한다.
 *
 * 2026-10-06 이전: 화면 코드가 처리 중이면 새 조각을 return으로 버렸다. 전사가 매달리는 동안의
 *   발화(응급 포함)가 서버에 닿지도 못했다. 동작을 lib/voiceprint/segment-queue.ts로 뺐다.
 */
import { describe, it, expect } from "vitest";
import { SegmentQueue } from "@/lib/voiceprint/segment-queue";

/** 수동으로 풀어 주는 처리기 — "처리 중" 상태를 테스트가 통제한다 */
function controllable() {
  const handled: string[] = [];
  const gates: (() => void)[] = [];
  const handle = (item: string) => new Promise<boolean>((resolve) => {
    gates.push(() => { handled.push(item); resolve(true); });
  });
  const releaseNext = async () => { gates.shift()?.(); await new Promise((r) => setTimeout(r, 0)); };
  return { handled, handle, releaseNext, pending: () => gates.length };
}

describe("처리 중에 들어온 조각", () => {
  it("버리지 않고 순서대로 처리한다", async () => {
    const c = controllable();
    const q = new SegmentQueue(c.handle, 5);
    void q.enqueue("a");                    // 처리 시작(매달림)
    void q.enqueue("b");                    // 🔒 예전엔 여기서 버려졌다
    void q.enqueue("넘어져서 못 일어나");
    await c.releaseNext(); await c.releaseNext(); await c.releaseNext();
    expect(c.handled).toEqual(["a", "b", "넘어져서 못 일어나"]);
  });

  it("넘치면 **오래된 것부터** 버린다 — 지금 막 한 말을 지킨다", async () => {
    const c = controllable();
    const q = new SegmentQueue(c.handle, 2);
    void q.enqueue("처리중");               // 대기열에서 빠져 처리 중
    void q.enqueue("오래된1");
    void q.enqueue("오래된2");
    void q.enqueue("최신-응급");             // 용량 2 초과 → 오래된1이 밀려난다
    for (let i = 0; i < 4; i++) await c.releaseNext();
    expect(c.handled).toEqual(["처리중", "오래된2", "최신-응급"]);
  });
});

describe("계속할 수 없는 응답", () => {
  it("처리기가 false면 **대기 중인 것까지** 비우고 멈춘다 (동의 필요·역할 불가)", async () => {
    const handled: string[] = [];
    const gates: (() => void)[] = [];
    // "403"은 false를 돌려준다 — 그 뒤에 쌓인 조각은 서버에 보내도 똑같이 거부되므로 보내지 않는다
    const q = new SegmentQueue((s: string) => new Promise<boolean>((resolve) => {
      gates.push(() => { handled.push(s); resolve(s !== "403"); });
    }), 5);
    void q.enqueue("403");                  // 처리 중(매달림)
    void q.enqueue("뒤1");
    void q.enqueue("뒤2");
    expect(q.size).toBe(2);
    gates.shift()!();                       // 403 응답
    await new Promise((r) => setTimeout(r, 0));
    expect(handled).toEqual(["403"]);
    expect(q.size, "대기 중이던 조각이 남아 있다").toBe(0);
    expect(gates.length, "403 뒤에도 다음 조각을 보냈다").toBe(0);
  });

  it("한 조각에서 예외가 나도 다음 조각은 처리된다", async () => {
    const handled: string[] = [];
    const q = new SegmentQueue(async (s: string) => { if (s === "boom") throw new Error("x"); handled.push(s); return true; }, 5);
    await Promise.all([q.enqueue("boom"), q.enqueue("살려줘")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(handled).toEqual(["살려줘"]);
  });
});

describe("stop", () => {
  it("멈춘 뒤에는 아무것도 처리하지 않는다", async () => {
    const c = controllable();
    const q = new SegmentQueue(c.handle, 5);
    void q.enqueue("a");
    void q.enqueue("b");
    q.stop();
    void q.enqueue("c");
    await c.releaseNext(); await c.releaseNext();
    expect(c.handled).toEqual(["a"]);        // 이미 처리 중이던 것만 끝난다
    expect(q.size).toBe(0);
  });
});
