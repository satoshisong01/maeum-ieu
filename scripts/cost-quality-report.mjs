/**
 * 원가·품질 **동시** 판정 리포트 — 검증 가이드 §3.
 *
 * 왜 한 표인가: 비용 변경을 단독으로 평가하면 "싸졌다"만 보이고 "선별이 멈췄다"는 안 보인다.
 *   2026-09-30에 동반자 모델을 내렸다가 확인턴 지시 준수가 깨져 **인지 선별이 소리 없이
 *   멈춘** 사고가 그 유형이다. 에러도 로그도 없이 품질만 떨어진다.
 *   그래서 이 스크립트는 두 축을 같은 출력에 찍는다 — 하나만 보고 판단할 수 없게.
 *
 * 입력: dev 서버를 `DEBUG_USAGE=1`로 띄워 남은 로그 파일.
 * 사용: node scripts/cost-quality-report.mjs <dev서버_로그경로>
 *
 * ⚠ 품질 축은 이 스크립트가 **측정하지 않는다**. 결정적 게이트의 결과를 사람이 넣어야 한다
 *   (아래 QUALITY_GATES). 자동화하면 "통과했다고 적어두고 안 돌리는" 길이 열린다.
 */
import fs from "node:fs";

const LOG = process.argv[2];
if (!LOG || !fs.existsSync(LOG)) {
  console.error("사용: node scripts/cost-quality-report.mjs <dev서버_로그경로>");
  console.error("  dev 서버를 DEBUG_USAGE=1 로 띄운 로그가 필요하다.");
  process.exit(1);
}

/**
 * 2026-10-01 ai.google.dev 공시가 ($/1M tokens). 환율은 아래 FX.
 * ⚠ 3.8-flash는 2026-12-31까지 프로모션가다 — 2027년엔 $1.50/$7.50으로 오른다.
 *   연말 전 모델 재검토가 현재 가격 정책의 전제다(덱 09 참조).
 */
const PRICE = {
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash": { in: 0.30, out: 2.50 },
};
const FX = 1391.3;   // 원/USD — 턴당 $0.00690 ≈ 9.6원 기준과 동일

const RX = /\[usage\] (\S+) model=(\S+) input=(\d+) output=(\d+) thinking=(\d+) cached=(\d+) total=(\d+)/;

const byLabel = new Map();
let lines = 0;
for (const line of fs.readFileSync(LOG, "utf-8").split(/\r?\n/)) {
  const m = line.match(RX);
  if (!m) continue;
  lines++;
  const [, label, model, inTok, outTok, think, cached] = m;
  const k = `${label}|${model}`;
  const a = byLabel.get(k) ?? { label, model, n: 0, in: 0, out: 0, think: 0, cached: 0 };
  a.n++; a.in += +inTok; a.out += +outTok; a.think += +think; a.cached += +cached;
  byLabel.set(k, a);
}

if (lines === 0) {
  console.error("❌ [usage] 로그가 0건이다 — DEBUG_USAGE=1 로 띄운 로그가 맞는지 확인할 것.");
  console.error("   (이 숫자가 0인데 '원가 측정 완료'라고 보고하면 그게 거짓 녹색이다)");
  process.exit(1);
}

/** 모델명에서 가격 키 찾기 — 공시에 없으면 명시적으로 알린다(조용히 0원 처리 금지) */
function priceOf(model) {
  for (const [k, v] of Object.entries(PRICE)) if (model.includes(k.replace("gemini-", ""))) return v;
  return null;
}

console.log(`\n===== 경로별 토큰·원가 (${lines}개 호출) =====`);
console.log(`${"경로".padEnd(18)}${"모델".padEnd(22)}${"호출".padStart(5)}${"입력".padStart(9)}${"출력".padStart(8)}${"thinking".padStart(9)}${"원가(원)".padStart(11)}`);
let totalKrw = 0;
const rows = [...byLabel.values()].sort((a, b) => b.n - a.n);
let unpriced = 0;
for (const r of rows) {
  const p = priceOf(r.model);
  if (!p) { unpriced++; }
  // 출력 토큰에 thinking이 포함되는지는 모델마다 다르다 — 보수적으로 출력에 합산한다(과소평가 금지)
  const usd = p ? (r.in / 1e6) * p.in + ((r.out + r.think) / 1e6) * p.out : 0;
  const krw = usd * FX;
  totalKrw += krw;
  console.log(
    `${r.label.padEnd(18)}${r.model.slice(0, 21).padEnd(22)}${String(r.n).padStart(5)}` +
    `${String(r.in).padStart(9)}${String(r.out).padStart(8)}${String(r.think).padStart(9)}` +
    `${(p ? krw.toFixed(1) : "가격미상").padStart(11)}`,
  );
}
if (unpriced) console.log(`\n⚠ 공시가를 모르는 모델 ${unpriced}종 — 위 원가는 과소평가다. PRICE 표를 갱신할 것.`);

// 대화 턴 수 추정 — 동반자 호출 수가 턴 수에 가장 가깝다
const turns = rows.filter((r) => /companion|chat/i.test(r.label)).reduce((s, r) => s + r.n, 0) || rows[0].n;
console.log(`\n합계 ${totalKrw.toFixed(0)}원 / 추정 턴 ${turns} → **턴당 ${(totalKrw / turns).toFixed(2)}원**`);

// 파생 지표 — 비용 "구조"가 의도대로인지 보는 눈. 총액만 보면 원인을 못 찾는다.
const cnt = (re) => rows.filter((r) => re.test(r.label)).reduce((s, r) => s + r.n, 0);
const probe = rows.filter((r) => /companion/.test(r.label) && r.model.includes("3.8")).reduce((s, r) => s + r.n, 0);
const chat = cnt(/companion/);
const lite = cnt(/analyzer-lite/);
const primary = rows.filter((r) => r.label === "analyzer").reduce((s, r) => s + r.n, 0);
const backstop = cnt(/emergency-llm/);
console.log(`파생: 확인턴 ${probe}/${chat}${chat ? ` (${((probe / chat) * 100).toFixed(0)}%, 목표 ~20%)` : ""}`);
console.log(`      분석기 lite ${lite} · primary ${primary} (probe 직행 포함 — 순수 승급률은 primary−probe컨텍스트)`);
console.log(`      응급 LLM 백스톱 ${backstop}회 (${((backstop / lines) * 100).toFixed(1)}%) — 사전필터가 평범한 발화를 걸러야 낮게 유지된다`);

console.log(`
⚠ **표본 편향을 먼저 확인할 것.** 이 수치는 로그에 남은 **모든** 호출의 평균이다.
   안전 스팟 체크(응급 발화 집중)나 검진을 함께 돌린 로그라면 평상시 원가보다 높게 나온다.
   덱의 기준값(턴당 9.6원)과 비교하려면 **e2e-roles 일상 대화만** 돌린 깨끗한 로그로 재측정할 것.
   섞인 표본으로 "원가가 올랐다/내렸다"를 판정하면 그게 F7(측정이 거짓)이다.`);

console.log(`
===== 품질 축 (가이드 §3 — 비용과 **같은 표**에서 판정한다) =====
⚠ 아래는 이 스크립트가 측정하지 않는다. 직접 돌리고 수치를 눈으로 확인할 것.
   자동으로 채우면 "통과했다고 적어두고 안 돌리는" 길이 열린다.

   npx vitest run --coverage              → 전수 통과 + 커버리지 래칫 충족
   npx tsx scripts/safety-regression.ts   → 342/342
   node scripts/e2e-safety-spots.mjs      → 17/17 (응급·자살·모더레이션·모드분리)
   node scripts/e2e-roles.mjs 30 user headless     → 실행 30/30, 이상 0, 5xx 0
   node scripts/e2e-roles.mjs 30 general headless  → 〃

합격 조건: 원가는 **하락 또는 동결**, 품질은 **하락 0**.
  품질이 1건이라도 떨어지면 비용이 아무리 싸도 불합격 — 되돌린다.
  확인 턴(probe)·검진(pro)·응급 판정은 비용 최적화 대상에서 **제외**한다.
`);
