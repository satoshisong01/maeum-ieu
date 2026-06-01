/**
 * e2e 연속 검증 러너 — 멈추지 않고 여러 라운드 반복.
 * 각 라운드: anomaly(10계정) + recall(6계정). 누적 요약은 docs/리포트_누적.md.
 *
 * 사용: node scripts/e2e-loop.mjs [rounds] [anomalyAccounts] [recallAccounts]
 *   rounds 0 또는 미지정 시 큰 수(1000)로 사실상 무한 — 멈추려면 프로세스 종료.
 */
import { spawnSync } from "child_process";

const ROUNDS = parseInt(process.argv[2] || "0", 10) || 1000;
const ANOM = process.argv[3] || "10";
const RECALL = process.argv[4] || "6";

function run(script, args) {
  const r = spawnSync("node", [script, ...args], { stdio: "inherit" });
  return r.status === 0;
}

function runTsx(script, args) { return spawnSync("npx", ["tsx", script, ...args], { stdio: "inherit", shell: true }).status === 0; }

for (let r = 1; r <= ROUNDS; r++) {
  console.log(`\n================= ROUND ${r} =================`);
  // 항목×강도 정밀 매트릭스 (판단 엔진)
  try { runTsx("scripts/matrix-verify.ts", ["3", `loop${r}`]); } catch (e) { console.log("matrix round err", e.message); }
  // 종합 위험도 4단계 판정 (순수 함수)
  try { runTsx("scripts/tier-verify.ts", [`loop${r}`]); } catch (e) { console.log("tier round err", e.message); }
  // 실제 앱 e2e
  try { run("scripts/e2e-screening.mjs", [ANOM, String(r)]); } catch (e) { console.log("anomaly round err", e.message); }
  try { run("scripts/e2e-recall.mjs", [RECALL, String(r)]); } catch (e) { console.log("recall round err", e.message); }
  console.log(`================= ROUND ${r} done =================`);
}
console.log("loop finished");
