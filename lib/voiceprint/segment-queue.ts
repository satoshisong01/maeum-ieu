/**
 * 상시 감시 발화 조각 처리 대기열 — 처리 중에 들어온 조각을 **버리지 않는다**.
 *
 * 왜 따로 두나: 예전엔 화면 코드 안에서 "처리 중이면 return"으로 새 조각을 버렸다. 서버 전사가
 *   몇 초, Gemini가 매달리면 수십 초 걸리는 동안의 발화가 전부 사라졌고, 그 안에 "넘어져서 못
 *   일어나"가 있어도 서버에 닿지 못했다(2026-10-06 적대 감사). 화면 코드에 있으면 테스트할 수
 *   없어서, 동작을 여기로 빼고 고정한다(__tests__/segment-queue.test.ts).
 *
 * 규칙:
 *   - 한 번에 하나씩 순서대로 처리한다(서버 부하·순서 보존).
 *   - 넘치면 **오래된 것부터** 버린다 — 응급엔 지금 막 한 말이 가장 중요하다.
 *   - 처리기가 false를 돌려주면(동의 필요·역할 불가처럼 계속할 수 없는 응답) 남은 것을 비우고 멈춘다.
 *   - stop() 뒤에는 아무것도 처리하지 않는다.
 */
export class SegmentQueue<T> {
  private items: T[] = [];
  private busy = false;
  private stopped = false;

  constructor(
    private readonly handle: (item: T) => Promise<boolean>,
    private readonly maxSize = 5,
  ) {}

  /** 조각을 넣고, 처리 중이 아니면 처리를 시작한다. 처리가 끝나면 resolve되는 promise를 돌려준다 */
  enqueue(item: T): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.items.push(item);
    if (this.items.length > this.maxSize) this.items.shift();
    return this.busy ? Promise.resolve() : this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.items = [];
  }

  /** 테스트·상태 표시용 */
  get size(): number { return this.items.length; }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.items.length > 0 && !this.stopped) {
        const next = this.items.shift() as T;
        let keepGoing = true;
        try { keepGoing = await this.handle(next); } catch { keepGoing = true; }   // 한 조각 실패가 대기열을 멈추지 않게
        if (!keepGoing) { this.items = []; break; }
      }
    } finally {
      this.busy = false;
    }
  }
}
