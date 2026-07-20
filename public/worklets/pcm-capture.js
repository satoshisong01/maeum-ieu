/**
 * Live 음성 마이크 캡처 워크렛 — Float32 → Int16 PCM, 1600샘플(100ms @16kHz) 단위 postMessage.
 * 정적 파일로 서빙하는 이유: CSP(script-src 'self')가 blob: 모듈을 차단 —
 * "Unable to load a worklet's module" (2026-07-20 실기기). 코드 출처: app/chat/live-voice.ts의 구 인라인 워크렛.
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const out = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
      this.buf.push(out);
      this.len += out.length;
      if (this.len >= 1600) {
        const merged = new Int16Array(this.len);
        let o = 0;
        for (const b of this.buf) { merged.set(b, o); o += b.length; }
        this.port.postMessage(merged.buffer, [merged.buffer]);
        this.buf = [];
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
