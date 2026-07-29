"use client";

/**
 * 성문 등록·대조용 마이크 녹음 — 16kHz mono Float32 누적.
 * 기존 음성 파이프라인의 정적 워크렛(public/worklets/pcm-capture.js, Int16 PCM)을 재사용해
 * getUserMedia→AudioContext(16k)→워크렛으로 프레임을 모아 Float32 [-1,1]로 반환한다.
 */

export interface Recording {
  audio: Float32Array; // 16kHz mono
  seconds: number;
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Int16Array[] = [];
  private samples = 0;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const src = this.ctx.createMediaStreamSource(this.stream);
    await this.ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.chunks = [];
    this.samples = 0;
    this.node.port.onmessage = (e) => {
      const frame = new Int16Array(e.data as ArrayBuffer);
      this.chunks.push(frame);
      this.samples += frame.length;
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
    this.ctx = null; this.stream = null; this.node = null; this.chunks = [];
    return { audio, seconds };
  }
}
