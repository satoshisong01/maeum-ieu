/**
 * Gemini API 공시 단가 (paid tier, $/1M tokens) — 2026-09-30 확인.
 * 출처: https://ai.google.dev/gemini-api/docs/pricing
 *
 * ⚠️ 3.6/3.7/3.8-flash는 **2026-12-31까지 도입가**이며 2027-01-01부터 입력·출력이 2배가 된다.
 *    출시 후 모델 교체는 비용이 크므로 후보 비교 시 2027년 단가도 함께 본다.
 */
export interface Price { in: number; out: number; cache: number; in2027?: number; out2027?: number }

export const PRICES: Record<string, Price> = {
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40, cache: 0.01 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.50, cache: 0.025 },
  "gemini-2.5-flash": { in: 0.30, out: 2.50, cache: 0.03 },
  "gemini-3.5-flash-lite": { in: 0.30, out: 2.50, cache: 0.03 },
  "gemini-3-flash-preview": { in: 0.50, out: 3.00, cache: 0.05 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75, cache: 0.075, in2027: 1.50, out2027: 7.50 },
  "gemini-3.7-flash": { in: 0.75, out: 3.75, cache: 0.075, in2027: 1.50, out2027: 7.50 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75, cache: 0.075, in2027: 1.50, out2027: 7.50 },
  "gemini-3.5-flash": { in: 1.50, out: 9.00, cache: 0.15 },
};

/**
 * 토큰 → 달러.
 * @param inTok  전체 입력 토큰(promptTokenCount) — 캐시 적중분을 포함한 값
 * @param cachedTok 그중 캐시 적중분(cachedContentTokenCount). 입력가의 10%만 과금(90% 할인).
 * @param future true면 2027년 단가(3.6/3.7/3.8-flash 도입가 종료 후) 적용
 *
 * 암묵 캐시는 Gemini 2.5 이상에서 기본 활성 — 실측에서 동반자 입력의 42%가 캐시 적중이었다.
 * 이를 무시하면 비용을 과대 계상한다.
 */
export function costOf(model: string, inTok: number, outTok: number, future = false, cachedTok = 0): number {
  const p = PRICES[model];
  if (!p) throw new Error(`단가 미등록 모델: ${model}`);
  const pin = future ? (p.in2027 ?? p.in) : p.in;
  const pout = future ? (p.out2027 ?? p.out) : p.out;
  const pcache = future && p.in2027 ? p.cache * 2 : p.cache;   // 도입가 종료 시 캐시가도 2배
  const cached = Math.min(Math.max(cachedTok, 0), inTok);
  const fresh = inTok - cached;
  return (fresh / 1e6) * pin + (cached / 1e6) * pcache + (outTok / 1e6) * pout;
}

/** 비교표용 — 도입가 종료로 값이 바뀌는 모델 표시 */
export const priceLabel = (m: string): string => {
  const p = PRICES[m];
  if (!p) return "?";
  return p.in2027 ? `$${p.in}/$${p.out} → 2027 $${p.in2027}/$${p.out2027}` : `$${p.in}/$${p.out}`;
};
