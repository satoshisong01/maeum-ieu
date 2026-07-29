"use client";

/**
 * 성문 등록·대조용 마이크 녹음 — 16kHz mono Float32 누적.
 * 기존 음성 파이프라인의 정적 워크렛(public/worklets/pcm-capture.js, Int16 PCM)을 재사용해
 * getUserMedia→AudioContext(16k)→워크렛으로 프레임을 모아 Float32 [-1,1]로 반환한다.
 */

export interface Recording {
  audio: Float32Array; // 16kHz mono
  seconds: number;
  peak: number;        // 녹음 중 최대 진폭(0~1) — 침묵/저음량 경고용
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Int16Array[] = [];
  private samples = 0;
  private peak = 0; // 녹음 전체 최대 진폭(0~1) — 침묵/저음량 판별

  /** onLevel: 100ms마다 현재 프레임의 RMS 음량(0~1) 콜백 — 실시간 파형/레벨 미터용 */
  async start(onLevel?: (level: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const src = this.ctx.createMediaStreamSource(this.stream);
    await this.ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.chunks = [];
    this.samples = 0;
    this.peak = 0;
    this.node.port.onmessage = (e) => {
      const frame = new Int16Array(e.data as ArrayBuffer);
      this.chunks.push(frame);
      this.samples += frame.length;
      // 프레임 RMS + peak (0~1) 산출
      let sumSq = 0, framePeak = 0;
      for (let i = 0; i < frame.length; i++) {
        const v = Math.abs(frame[i]) / 32768;
        sumSq += v * v;
        if (v > framePeak) framePeak = v;
      }
      if (framePeak > this.peak) this.peak = framePeak;
      if (onLevel) onLevel(Math.sqrt(sumSq / frame.length));
    };
    src.connect(this.node);
  }

  get seconds(): number {
    return this.samples / 16000;
  }

  async stop(): Promise<Recording> {
    try { this.node?.disconnect(); } catch { /* noop */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    const merged = new Int16Array(this.samples);
    let off = 0;
    for (const c of this.chunks) { merged.set(c, off); off += c.length; }
    const audio = new Float32Array(this.samples);
    for (let i = 0; i < this.samples; i++) audio[i] = merged[i] / 32768;
    const seconds = this.samples / 16000;
    const peak = this.peak;
    this.ctx = null; this.stream = null; this.node = null; this.chunks = [];
    return { audio, seconds, peak };
  }
}
