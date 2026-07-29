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
    // 모델은 same-origin 정적 자산(/models/)에서만 로드(외부 모델 금지). wasm 런타임만 기본 CDN 사용.
    //   브라우저는 allowLocalModels 기본 false → 명시적으로 켜야 self-host 경로에서 로드됨(2026-07-29 실기기).
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = "/models/";
    const processor = await AutoProcessor.from_pretrained("wespeaker-voiceprint");
    const model = await AutoModel.from_pretrained("wespeaker-voiceprint", { dtype: "q8" });
    return { processor, model };
  })();
  return _extractor;
}

/** 미리 로드(등록 화면 진입 시 호출 — 첫 추출 지연 숨김) */
export async function warmupVoiceprint(): Promise<void> {
  try { await getExtractor(); } catch { /* 실패는 추출 시점에 표면화 */ }
}

/** 16kHz mono Float32 오디오 → 256차원 성문 임베딩 */
export async function extractVoiceprint(audio: Float32Array): Promise<number[]> {
  const { processor, model } = await getExtractor();
  const inputs = await processor(audio);
  const { last_hidden_state } = await model(inputs);
  return last_hidden_state.tolist()[0] as number[];
}

/** 코사인 유사도 (클라 즉시 표시용 — 서버도 동일 계산으로 판정) */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
