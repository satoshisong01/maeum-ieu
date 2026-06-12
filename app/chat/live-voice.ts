"use client";

/**
 * Live 음성 엔진 (베타) — Gemini Live API 클라이언트 직결.
 * PoC 실측(scripts/poc-live-api.mjs): 첫 음성 1.44s (현행 STT 경로 6.1s 대비 76%↓).
 *
 * 구조:
 *  - 서버에서 ephemeral token 발급(POST /api/live/token) → 브라우저가 WS 직결 (API key 비노출)
 *  - 마이크: AudioWorklet으로 16kHz 16bit PCM 캡처 → sendRealtimeInput (VAD는 모델 내장)
 *  - 출력: 24kHz PCM 청크 재생. **안전망 게이트**: 출력 전사가 오디오보다 ~0.5s 선행 —
 *    첫 전사를 회상정답/누출 검사에 통과시킨 뒤 재생 시작, 위반 시 해당 턴 음소거(텍스트만 표시)
 *  - 턴 완료: 전사 쌍을 /api/live/turn으로 회송 (저장 + 인지분석) — 호출측 책임
 *
 * v1 제약(문서화): 검진(mental flow)·모더레이션 즉답 게이트는 이 경로 미지원.
 * 응급은 /api/live/turn 응답의 emergencyLevel로 후행 감지(클라가 안내 모드 전환).
 */
import { stripRecallAnswerLeak } from "@/lib/chat/korean-particle";

const LEAK_RE = /print\(|google_search|tool_code|thought\s*:|the user (is|wants|said)|i should|"isAnomaly"/i;

export interface LiveVoiceCallbacks {
  onState: (s: "connecting" | "listening" | "speaking" | "stopped" | "error") => void;
  onUserTranscript: (text: string) => void;
  onAiTranscript: (text: string) => void;
  onTurnComplete: (userText: string, aiText: string) => void;
  onError: (msg: string) => void;
}

interface LiveSessionLike {
  sendRealtimeInput: (input: unknown) => void;
  close: () => void;
}

export class LiveVoiceEngine {
  private cb: LiveVoiceCallbacks;
  private session: LiveSessionLike | null = null;
  private micCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private outCtx: AudioContext | null = null;
  private playHead = 0;
  private gateOpen = false;   // 이번 턴 오디오 재생 허용 여부 (전사 안전검사 통과 시 true)
  private muteTurn = false;   // 위반 감지 — 이번 턴 끝까지 음소거
  private pendingAudio: Int16Array[] = [];
  private userBuf = "";
  private aiBuf = "";
  private stopped = false;

  constructor(cb: LiveVoiceCallbacks) {
    this.cb = cb;
  }

  async start(opts?: { fakeMic?: boolean }) {
    this.cb.onState("connecting");
    const tokRes = await fetch("/api/live/token", { method: "POST" });
    if (!tokRes.ok) throw new Error("토큰 발급 실패");
    const { token, model } = await tokRes.json();

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });

    // ⚠ 세션 config(모달리티·전사·페르소나)는 토큰의 liveConnectConstraints에 서버가 박아둠 —
    //   Constrained 연결에선 클라 config가 무시됨(전사 미수신으로 실증, 2026-06-12). 여기선 model만 전달.
    this.session = (await ai.live.connect({
      model,
      callbacks: {
        onopen: () => { if (!this.stopped) this.cb.onState("listening"); },
        onmessage: (m: unknown) => {
          if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__liveDebug) {
            console.log("[live:msg]", JSON.stringify(m).slice(0, 400));
          }
          this.handleMessage(m);
        },
        onerror: (e: unknown) => { console.error("[live:err]", e); this.cb.onError(String((e as Error)?.message || e)); this.cb.onState("error"); },
        onclose: (e: unknown) => {
          const ce = e as { code?: number; reason?: string };
          if (ce?.reason) console.warn("[live:close]", ce.code, ce.reason);
          if (!this.stopped) this.cb.onState("stopped");
        },
      },
    })) as LiveSessionLike;

    if (!opts?.fakeMic) await this.startMic();
  }

  /** 테스트 훅 — Playwright 등 마이크 없는 환경에서 PCM(base64, 16k 16bit) 주입 */
  injectPcm(b64: string) {
    this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
  }
  endInjectedUtterance() {
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  private async startMic() {
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } });
    this.micCtx = new AudioContext({ sampleRate: 16000 });
    const src = this.micCtx.createMediaStreamSource(this.micStream);
    // 인라인 워크렛: Float32 → Int16, 1600샘플(100ms) 단위 postMessage
    const workletCode = `
      class PcmCapture extends AudioWorkletProcessor {
        constructor() { super(); this.buf = []; this.len = 0; }
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (ch) {
            const out = new Int16Array(ch.length);
            for (let i = 0; i < ch.length; i++) out[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
            this.buf.push(out); this.len += out.length;
            if (this.len >= 1600) {
              const merged = new Int16Array(this.len); let o = 0;
              for (const b of this.buf) { merged.set(b, o); o += b.length; }
              this.port.postMessage(merged.buffer, [merged.buffer]);
              this.buf = []; this.len = 0;
            }
          }
          return true;
        }
      }
      registerProcessor("pcm-capture", PcmCapture);`;
    const url = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    await this.micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.micCtx, "pcm-capture");
    node.port.onmessage = (e) => {
      if (this.stopped || !this.session) return;
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      this.session.sendRealtimeInput({ audio: { data: btoa(bin), mimeType: "audio/pcm;rate=16000" } });
    };
    src.connect(node);
  }

  // ── 수신 처리 ──────────────────────────────────────────────────────────────
  private handleMessage(m: unknown) {
    const msg = m as {
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string }; text?: string }[] };
        outputTranscription?: { text?: string };
        inputTranscription?: { text?: string };
        interrupted?: boolean;
        turnComplete?: boolean;
      };
    };
    const sc = msg?.serverContent;
    if (!sc) return;

    if (sc.interrupted) { this.resetPlayback(); return; } // 사용자가 끼어듦 — 재생 중단(barge-in)

    const inT = sc.inputTranscription?.text;
    if (inT) { this.userBuf += inT; this.cb.onUserTranscript(this.userBuf); }

    const outT = sc.outputTranscription?.text;
    if (outT) {
      this.aiBuf += outT;
      // 안전망 게이트: 첫 전사 도착 시(오디오보다 ~0.5s 선행) 회상정답/누출 검사
      if (!this.gateOpen && !this.muteTurn) {
        const cleaned = stripRecallAnswerLeak(this.aiBuf);
        if (LEAK_RE.test(this.aiBuf) || cleaned !== this.aiBuf) {
          this.muteTurn = true; // 위반 — 이번 턴 오디오 전체 음소거, 텍스트는 정화본 표시
          this.pendingAudio = [];
        } else {
          this.gateOpen = true;
          this.flushPendingAudio();
        }
      }
      this.cb.onAiTranscript(this.muteTurn ? stripRecallAnswerLeak(this.aiBuf) : this.aiBuf);
    }

    for (const p of sc.modelTurn?.parts || []) {
      if (p.inlineData?.data) this.enqueueAudio(p.inlineData.data);
    }

    if (sc.turnComplete) {
      const u = this.userBuf.trim(), a = (this.muteTurn ? stripRecallAnswerLeak(this.aiBuf) : this.aiBuf).trim();
      if (u && a) this.cb.onTurnComplete(u, a);
      this.userBuf = ""; this.aiBuf = "";
      this.gateOpen = false; this.muteTurn = false;
      this.cb.onState("listening");
    }
  }

  // ── 오디오 재생 (24kHz PCM16) ─────────────────────────────────────────────
  private enqueueAudio(b64: string) {
    if (this.muteTurn) return;
    const bin = atob(b64);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    if (!this.gateOpen) { this.pendingAudio.push(pcm); return; } // 전사 검사 전 — 버퍼링
    this.playPcm(pcm);
  }

  private flushPendingAudio() {
    for (const pcm of this.pendingAudio) this.playPcm(pcm);
    this.pendingAudio = [];
  }

  private playPcm(pcm: Int16Array) {
    if (!this.outCtx) { this.outCtx = new AudioContext({ sampleRate: 24000 }); this.playHead = this.outCtx.currentTime; }
    const buf = this.outCtx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outCtx.destination);
    const startAt = Math.max(this.outCtx.currentTime, this.playHead);
    src.start(startAt);
    this.playHead = startAt + buf.duration;
    this.cb.onState("speaking");
  }

  private resetPlayback() {
    this.pendingAudio = [];
    if (this.outCtx) { this.outCtx.close().catch(() => {}); this.outCtx = null; }
    this.playHead = 0;
  }

  stop() {
    this.stopped = true;
    try { this.session?.close(); } catch { /* noop */ }
    this.session = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micCtx?.close().catch(() => {});
    this.resetPlayback();
    this.cb.onState("stopped");
  }
}
