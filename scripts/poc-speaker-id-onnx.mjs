/**
 * 화자식별 PoC 재검증 — 앱 실사용 모델(transformers.js + wespeaker resnet34-LM ONNX)로
 * 어제 6화자 셋(ECAPA 100%) 재측정. 이 모델이 앱(WebView)에서 돌 것이므로 여기서 통과해야 착수.
 * 사용: node scripts/poc-speaker-id-onnx.mjs <audioDir>
 */
import { AutoProcessor, AutoModel, cos_sim, Tensor } from "@huggingface/transformers";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2];
if (!DIR) { console.error("audioDir 필요"); process.exit(1); }

// LINEAR16 16kHz mono WAV → Float32Array [-1,1] (44바이트 헤더 스킵)
function readWav(path) {
  const buf = readFileSync(path);
  const pcm = buf.subarray(44);
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

console.log("모델 로드 중 (wespeaker resnet34-LM)…");
const MODEL = "onnx-community/wespeaker-voxceleb-resnet34-LM";
const processor = await AutoProcessor.from_pretrained(MODEL);
const model = await AutoModel.from_pretrained(MODEL);

async function embed(path) {
  const audio = readWav(path);
  const inputs = await processor(audio);
  const { last_hidden_state } = await model(inputs);
  return last_hidden_state.tolist()[0]; // 256-d
}

const trueSpeaker = (d) => d.split("-").pop();
const dirs = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name).sort();
const speakers = [...new Set(dirs.map(trueSpeaker))].sort();
console.log(`디렉터리 ${dirs.length}개 -> 실제 화자 ${speakers.length}명: ${speakers.join(", ")}\n`);

// 등록 — 성문(등록 임베딩 평균)
const prints = {};
for (const s of speakers) {
  const paths = [];
  for (const d of dirs) if (trueSpeaker(d) === s) {
    for (const f of readdirSync(join(DIR, d))) if (f.startsWith("enroll_")) paths.push(join(DIR, d, f));
  }
  const embs = [];
  for (const p of paths) embs.push(await embed(p));
  const mean = embs[0].map((_, i) => embs.reduce((a, e) => a + e[i], 0) / embs.length);
  prints[s] = mean;
  console.log(`등록: 화자 ${s} (클립 ${embs.length})`);
}

// 대조
let correct = 0, total = 0;
const same = [], diff = [];
console.log("\n[테스트 클립별 판정]");
for (const d of dirs) {
  const s = trueSpeaker(d);
  for (const f of readdirSync(join(DIR, d))) {
    if (!f.startsWith("test_")) continue;
    const e = await embed(join(DIR, d, f));
    const scores = Object.fromEntries(speakers.map((n) => [n, cos_sim(e, prints[n])]));
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    const ok = best === s;
    correct += ok; total++;
    same.push(scores[s]);
    diff.push(...Object.entries(scores).filter(([k]) => k !== s).map(([, v]) => v));
    const bestOther = Math.max(...Object.entries(scores).filter(([k]) => k !== s).map(([, v]) => v));
    console.log(`  ${ok ? "O" : "X"} ${d}/${f} -> ${best} (본인 ${scores[s].toFixed(3)} / 최고타인 ${bestOther.toFixed(3)})`);
  }
}

const sameMin = Math.min(...same), diffMax = Math.max(...diff);
const margin = sameMin - diffMax;
console.log(`\n===== 결과 (wespeaker resnet34-LM) =====`);
console.log(`식별 정확도: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`);
console.log(`본인 유사도: 최소 ${sameMin.toFixed(3)} / 평균 ${(same.reduce((a, b) => a + b) / same.length).toFixed(3)}`);
console.log(`타인 유사도: 최대 ${diffMax.toFixed(3)} / 평균 ${(diff.reduce((a, b) => a + b) / diff.length).toFixed(3)}`);
console.log(`판별 마진: ${margin >= 0 ? "+" : ""}${margin.toFixed(3)} ${margin > 0 ? `-> 임계값 ${((sameMin + diffMax) / 2).toFixed(2)} 권장` : "-> 분포 겹침"}`);
