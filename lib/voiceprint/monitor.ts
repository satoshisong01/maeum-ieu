"use client";

/**
 * 상시 감시 녹음 — 연속 청취하며 "발화 단위"로 자동 분할(관찰자 모드).
 * 에너지 VAD: RMS가 문턱 이상이면 발화 시작 → 침묵 SILENCE_MS 지속되면 그 구간을 한 조각으로 마감.
 * 한 조각이 MAX_SEG_MS를 넘으면 강제 마감(계속 말하는 경우 대비). 최소 길이 미만은 버림(잡음).
 *
 * 출력: onSegment(Float32Array 16kHz) — 호출자가 화자식별(환자?)→통과 시에만 서버 전송.
 * 원음성은 이 단계에선 기기 안에만 있음. 다른 사람/잡음 조각은 호출자가 화자식별로 걸러 폐기.
 */

const SILENCE_MS = 2000;   // 침묵 이만큼 지속되면 발화 종료
const MAX_SEG_MS = 30000;  // 한 조각 최대 길이(강제 컷)
const MIN_SEG_MS = 800;    // 이보다 짧은 발화는 잡음으로 폐기
const START_RMS = 0.04;    // 발화 시작으로 볼 RMS 문턱
const KEEP_RMS = 0.02;     // 발화 유지(침묵 아님)로 볼 RMS 문턱(히스테리시스)
const PREROLL_FRAMES = 3;  // 발화 시작 전 프레임 약간 포함(앞부분 잘림 방지, 100ms×3)

export interface MonitorCallbacks {
  onLevel?: (level: number) => void;                 // 실시간 음량(0~1) — 파형용
  onSegment: (audio: Float32Array, seconds: number) => void; // 발화 조각 마감 시
  onState?: (speaking: boolean) => void;             // 발화 중/침묵 전환
  onError?: (msg: string) => void;
}

export class VoiceMonitor {
  private cb: MonitorCallbacks;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private running = false;

  private speaking = false;
  private seg: Int16Array[] = [];       // 현재 발화 누적
  private pre: Int16Array[] = [];       // 발화 직전 pre-roll 링버퍼
  private segSamples = 0;
  private silenceMs = 0;
  private segMs = 0;
  private readonly frameMs = 100;       // pcm-capture가 1600샘플(100ms) 단위로 post

  constructor(cb: MonitorCallbacks) { this.cb = cb; }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const src = this.ctx.createMediaStreamSource(this.stream);
    await this.ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.running = true;
    this.node.port.onmessage = (e) => this.onFrame(new Int16Array(e.data as ArrayBuffer));
    src.connect(this.node);
  }

  private onFrame(frame: Int16Array) {
    if (!this.running) return;
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) { const v = frame[i] / 32768; sumSq += v * v; }
    const rms = Math.sqrt(sumSq / frame.length);
    this.cb.onLevel?.(rms);

    if (!this.speaking) {
      // pre-roll 링버퍼 유지
      this.pre.push(frame);
      if (this.pre.length > PREROLL_FRAMES) this.pre.shift();
      if (rms >= START_RMS) {
        // 발화 시작 — pre-roll 포함
        this.speaking = true;
        this.cb.onState?.(true);
        this.seg = [...this.pre];
        this.segSamples = this.seg.reduce((a, f) => a + f.length, 0);
        this.pre = [];
        this.silenceMs = 0;
        this.segMs = this.seg.length * this.frameMs;
      }
      return;
    }

    // 발화 중
    this.seg.push(frame);
    this.segSamples += frame.length;
    this.segMs += this.frameMs;
    this.silenceMs = rms >= KEEP_RMS ? 0 : this.silenceMs + this.frameMs;

    if (this.silenceMs >= SILENCE_MS || this.segMs >= MAX_SEG_MS) {
      this.finalizeSegment();
    }
  }

  private finalizeSegment() {
    const samples = this.segSamples;
    const durMs = this.segMs;
    const chunks = this.seg;
    this.speaking = false;
    this.cb.onState?.(false);
    this.seg = []; this.segSamples = 0; this.silenceMs = 0; this.segMs = 0;
    if (durMs < MIN_SEG_MS) return; // 잡음 폐기

    const merged = new Int16Array(samples);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    const audio = new Float32Array(samples);
    for (let i = 0; i < samples; i++) audio[i] = merged[i] / 32768;
    this.cb.onSegment(audio, samples / 16000);
  }

  stop(): void {
    this.running = false;
    try { this.node?.disconnect(); } catch { /* noop */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null; this.stream = null; this.node = null;
    this.seg = []; this.pre = []; this.speaking = false;
  }
}
