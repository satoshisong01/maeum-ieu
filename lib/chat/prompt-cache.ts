/**
 * 명시적 프롬프트 컨텍스트 캐싱 — 안정 프리픽스(base+user+profile+summary)를 Gemini 캐시에 올려
 * 매 턴 재처리되던 입력 토큰(실측 12~16k/턴)을 줄인다.
 *
 * 배경(2026-06-17 실측): 이 계정/모델(gemini-2.5-flash)에서 **암묵(implicit) 캐시는 미작동(cached=0)**,
 * 명시적 캐시는 작동(cached≈프리픽스 전체). 따라서 명시적 캐시만 비용 절감 효과 있음.
 *
 * 안전장치:
 *  - **env PROMPT_CACHE=1 일 때만 활성**(기본 off — 비용 모니터링 후 켜기). off면 항상 null → 비캐시 경로.
 *  - best-effort: 생성 실패 시 null → 호출부가 비캐시 경로로 폴백(동작·정확성 무영향).
 *  - 사용자별 1개 캐시(in-memory). 프리픽스 변경(profile/summary 갱신) 또는 만료 시 재생성.
 *  - 짧은 TTL로 저장비용 제한(활성 대화 재사용 구간만).
 */
import { createHash } from "crypto";
import { getGenAI } from "@/lib/chat/llm";

const MODEL = "gemini-2.5-flash";
const TTL_SEC = 600;       // 10분 — 활성 대화 재사용 구간
const MIN_CHARS = 2000;    // 너무 짧으면 캐시 효용·최소토큰 미달 → 스킵

interface Entry { name: string; hash: string; expiresAt: number; }
const cacheByUser = new Map<string, Entry>();

const hashOf = (s: string): string => createHash("sha1").update(s).digest("hex");

/** 사용자 안정 프리픽스용 캐시 이름 반환. 비활성/너무짧음/실패 시 null(비캐시 폴백). */
export async function getPrefixCache(userId: string, stablePrompt: string): Promise<string | null> {
  if (process.env.PROMPT_CACHE !== "1") return null;
  if (!stablePrompt || stablePrompt.length < MIN_CHARS) return null;

  const hash = hashOf(stablePrompt);
  const now = Date.now();
  const cur = cacheByUser.get(userId);
  if (cur && cur.hash === hash && cur.expiresAt > now + 30_000) return cur.name; // 30s 여유

  try {
    const cache = await getGenAI().caches.create({
      model: MODEL,
      config: { systemInstruction: stablePrompt, ttl: `${TTL_SEC}s` },
    });
    if (!cache?.name) return null;
    cacheByUser.set(userId, { name: cache.name, hash, expiresAt: now + TTL_SEC * 1000 });
    // 이전(변경된) 캐시 정리 — best-effort
    if (cur && cur.name !== cache.name) {
      getGenAI().caches.delete({ name: cur.name }).catch(() => { /* ignore */ });
    }
    return cache.name;
  } catch (e) {
    console.warn("[prompt-cache] create 실패(비캐시 폴백):", (e as Error).message);
    return null;
  }
}
