/**
 * 간이 인메모리 rate limit — 단일 인스턴스 기준 baseline.
 * ⚠️ 멀티 인스턴스/서버리스 배포 시에는 Redis/Upstash 등 분산 저장소로 교체해야 함
 *    (인메모리는 인스턴스마다 독립적이라 전역 제한이 안 됨).
 *
 * 고비용 엔드포인트(/api/chat 등)에서 단일 계정의 폭주를 막는 1차 방어.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

// 메모리 누수 방지 — 만료 버킷 주기적 정리
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
}

/**
 * key 기준 고정 윈도우 카운터. windowMs 안에 limit 초과 시 거부.
 * @returns ok=false면 retryAfterSec(초) 포함
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  sweep(now);
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  if (b.count >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  }
  b.count++;
  return { ok: true, retryAfterSec: 0 };
}
