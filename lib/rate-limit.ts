/**
 * Rate limit — Upstash(분산) 우선, 미설정 시 인메모리(단일 인스턴스) 폴백.
 *
 * ⚠️ Vercel 등 서버리스/멀티 인스턴스에서는 인메모리가 인스턴스마다 독립이라 한도가 실효하지 않음.
 *    UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN 설정 시 분산 카운터로 전역 제한이 동작.
 *
 * checkRateLimit는 비동기 — 호출부에서 await 필요.
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

// ── 인메모리 폴백 (단일 인스턴스 baseline) ──
const buckets = new Map<string, { count: number; resetAt: number }>();
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
}
function inMemory(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  if (b.count >= limit) return { ok: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  b.count++;
  return { ok: true, retryAfterSec: 0 };
}

// ── Upstash(분산) ──
let redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  redis = url && token ? new Redis({ url, token }) : null;
  return redis;
}
const limiters = new Map<string, Ratelimit>();
function getLimiter(limit: number, windowMs: number): Ratelimit | null {
  const r = getRedis();
  if (!r) return null;
  const k = `${limit}:${windowMs}`;
  let l = limiters.get(k);
  if (!l) {
    l = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
      prefix: "maeum_rl",
      analytics: false,
    });
    limiters.set(k, l);
  }
  return l;
}

/**
 * key 기준 rate limit 확인. windowMs 안에 limit 초과 시 거부.
 * Upstash 설정 시 분산 카운터, 아니면 인메모리. 실패 시 인메모리 폴백(가용성 우선).
 */
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const limiter = getLimiter(limit, windowMs);
  if (!limiter) return inMemory(key, limit, windowMs);
  try {
    const res = await limiter.limit(key);
    return { ok: res.success, retryAfterSec: res.success ? 0 : Math.max(0, Math.ceil((res.reset - Date.now()) / 1000)) };
  } catch (e) {
    console.warn("[rate-limit] Upstash 실패 — 인메모리 폴백:", (e as Error).message);
    return inMemory(key, limit, windowMs);
  }
}
