"use client";

/**
 * 화자 성문(voiceprint) 추출 — 클라이언트(브라우저/WebView) 온디바이스.
 *
 * 관찰자 모드 화자식별의 등록·대조에 쓰는 256차원 임베딩을 기기 안에서 뽑는다.
 * 원음성은 기기를 떠나지 않고, 서버로는 벡터(숫자 배열)만 전송 → 통신비밀보호법·프라이버시 유리.
 *
 * 모델: onnx-community/wespeaker-voxceleb-resnet34-LM (q8 양자화, public/models/에 자체 호스팅).
 *   PoC 실측(scripts/poc-speaker-id-onnx.mjs): 합성 6화자 100% 식별, 판별 마진 +0.27, 임계값 0.71.
 * 런타임: transformers.js(@huggingface/transformers) + onnxruntime-web(WASM). CSP의 'unsafe-eval'로 WASM 허용.
 *   ORT wasm 바이너리는 jsDelivr에서 로드(오디오·데이터는 전송 안 됨 — 런타임 코드만). 모델은 self-host.
 */

export { VOICEPRINT_MODEL_ID, VOICEPRINT_THRESHOLD } from "./constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _extractor: Promise<{ processor: any; model: any }> | null = null;

async function getExtractor() {
  if (_extractor) return _extractor;
  _extractor = (async () => {
    const { AutoProcessor, AutoModel, env } = await import("@huggingface/transformers");
    // 모델은 same-origin 정적 자산(/models/)에서만 로드(외부 모델 금지).
    //   브라우저는 allowLocalModels 기본 false → 명시적으로 켜야 self-host 경로에서 로드됨(2026-07-29 실기기).
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = "/models/";
    // ORT WASM 런타임도 자체 호스팅(/ort/) — CDN 스크립트를 CSP에 열지 않기 위함(건강앱 보안).
    //   proxy=false: blob 워커를 안 만들어 'blob 모듈 동적 import 차단'(2026-07-29 실기기) 회피 + script-src 'self' 유지.
    //   numThreads=1: SharedArrayBuffer(COOP/COEP) 불필요. 등록·대조는 단발이라 메인스레드로 충분.
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) {
      wasm.wasmPaths = "/ort/";
      wasm.proxy = false;
      wasm.numThreads = 1;
    }
    const processor = await AutoProcessor.from_pretrained("wespeaker-voiceprint");
    // ⚠ dtype는 fp32 필수 — q8 양자화 모델은 onnxruntime-web(브라우저 WASM)에서 임베딩이
    //   뭉개져(다른 성별도 동일인으로 오인식) 화자 구분이 붕괴됨(2026-07-31 실기기). node에선 정상이라
    //   ORT-web의 int8 경로 문제로 판단. fp32(26.5MB)는 수치적으로 안전 — 정확성 우선.
    const model = await AutoModel.from_pretrained("wespeaker-voiceprint", { dtype: "fp32" });
    return { processor, model };
  })();
  return _extractor;
}

/** 미리 로드(등록 화면 진입 시 호출 — 첫 추출 지연 숨김) */
export async function warmupVoiceprint(): Promise<void> {
  try { await getExtractor(); } catch { /* 실패는 추출 시점에 표면화 */ }
}

/** 16kHz mono Float32 오디오 → 256차원 성문 임베딩(단일 창) */
export async function extractVoiceprint(audio: Float32Array): Promise<number[]> {
  const { processor, model } = await getExtractor();
  const inputs = await processor(audio);
  const { last_hidden_state } = await model(inputs);
  return last_hidden_state.tolist()[0] as number[];
}

function l2normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/**
 * 여러 창(window)으로 나눠 임베딩을 뽑아 평균(정규화 후) → 안정적인 성문.
 * 통짜 1회 추출은 노이즈에 흔들려 본인도 유사도가 낮게 나올 수 있음 — PoC에서 다개 평균이 100%를 낸 방식.
 * 짧으면 자동으로 단일 창 처리.
 */
export async function extractVoiceprintRobust(audio: Float32Array, windowSec = 4, stepSec = 2): Promise<number[]> {
  const SR = 16000;
  const win = Math.floor(windowSec * SR);
  const step = Math.floor(stepSec * SR);
  const segs: Float32Array[] = [];
  if (audio.length <= win + step) {
    segs.push(audio);
  } else {
    for (let start = 0; start + win <= audio.length; start += step) {
      segs.push(audio.subarray(start, start + win));
    }
  }
  const embs: number[][] = [];
  for (const s of segs) embs.push(l2normalize(await extractVoiceprint(s)));
  const dim = embs[0].length;
  const mean = new Array(dim).fill(0);
  for (const e of embs) for (let i = 0; i < dim; i++) mean[i] += e[i];
  for (let i = 0; i < dim; i++) mean[i] /= embs.length;
  return l2normalize(mean);
}

/** 코사인 유사도 (클라 즉시 표시용 — 서버도 동일 계산으로 판정) */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
