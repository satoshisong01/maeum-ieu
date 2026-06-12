/**
 * Live API PoC — 음성 첫 응답 지연 실측 (docs/LIVE_API_검토_2026-06-12.md §6 P1).
 *
 * 구조: Cloud TTS로 어르신 발화 합성(LINEAR16 16kHz PCM) → Live API에 실시간 스트리밍 입력
 *      → TEXT 모달리티 응답의 첫 청크까지 지연 측정 (+입력 전사 확인).
 * 비교 기준: 현행 STT→LLM 경로 첫 chunk 6.1~6.5초 (scripts/measure-voice-latency.mjs 실측).
 *
 * 사용: node scripts/poc-live-api.mjs [반복수=3]
 */
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import textToSpeech from "@google-cloud/text-to-speech";

const N = parseInt(process.argv[2] || "3", 10);
const FORCE_MODEL = process.argv[3] || null;
const DEBUG = process.env.POC_DEBUG === "1";
const UTTERANCES = [
  "오늘 날씨가 참 좋네. 산책이라도 갈까 싶어",
  "아침에 미역국 끓여 먹었어",
  "요즘 무릎이 좀 시큰거려서 걱정이야",
];

// Live API 모델 후보 — 가용성이 키·시점에 따라 달라 순차 시도
const LIVE_MODELS = [
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-3.1-flash-live-preview",
  "gemini-live-2.5-flash-preview",
  "gemini-2.0-flash-live-001",
];

const SYS = `당신은 노인 돌봄 AI 동반자 '지윤'입니다. 할머니의 말에 1~2문장으로 따뜻하게 공감하며 한국어로 답하세요.`;

async function synthPcm16k(text) {
  const client = new textToSpeech.TextToSpeechClient();
  const [res] = await client.synthesizeSpeech({
    input: { text },
    voice: { languageCode: "ko-KR", name: "ko-KR-Neural2-A" },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 16000 },
  });
  const buf = Buffer.from(res.audioContent);
  // LINEAR16은 WAV 컨테이너 — 44바이트 헤더 제거 → raw PCM
  return buf.subarray(44);
}

// ⚠ PoC 실측 결과(2026-06-12): 가용 Live 모델 전부 TEXT 모달리티 미지원(1007) — AUDIO 전용.
//   → 측정 목표 변경: 첫 오디오 청크 + 출력 전사(안전망 게이트 가능성) + 입력 전사(인지분석 입력) 타이밍.
function connectLive(ai, model, onEvent) {
  return ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: SYS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // thinking이 첫 오디오를 1초+ 지연시키는 것으로 관측 — 대화 응답엔 불필요(현행 동반자도 256)
      thinkingConfig: { thinkingBudget: 0 },
    },
    callbacks: {
      onopen: () => onEvent({ type: "open" }),
      onmessage: (m) => onEvent({ type: "msg", m }),
      onerror: (e) => onEvent({ type: "err", e }),
      onclose: (e) => onEvent({ type: "close", e }),
    },
  });
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY 미설정");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // 모델 가용성 탐색
  let model = null, session = null;
  for (const m of (FORCE_MODEL ? [FORCE_MODEL] : LIVE_MODELS)) {
    try {
      let failed = false;
      const events = [];
      const s = await connectLive(ai, m, (ev) => { events.push(ev); if (ev.type === "err" || (ev.type === "close" && !ev.e?.wasClean)) failed = true; });
      await new Promise((r) => setTimeout(r, 1200));
      if (!failed) { model = m; session = s; break; }
      try { s.close(); } catch {}
      console.log(`  · ${m}: 연결 실패 (${events.find((e) => e.type === "close")?.e?.reason || "unknown"})`);
    } catch (e) {
      console.log(`  · ${m}: ${String(e.message).slice(0, 80)}`);
    }
  }
  if (!model) throw new Error("가용한 Live 모델 없음");
  console.log(`\n✅ Live 모델: ${model}\n`);
  try { session.close(); } catch {}

  const results = [];
  for (let i = 0; i < N; i++) {
    const text = UTTERANCES[i % UTTERANCES.length];
    const pcm = await synthPcm16k(text);

    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const state = { tSendEnd: 0, tFirstAudio: 0, tFirstOutText: 0, tFirstStt: 0, tTurnDone: 0, textOut: "", stt: "", err: null, audioBytes: 0 };

    const s = await connectLive(ai, model, (ev) => {
      if (ev.type === "msg") {
        const m = ev.m;
        if (DEBUG) console.log("  [msg]", JSON.stringify(m).slice(0, 300));
        const parts = m?.serverContent?.modelTurn?.parts || [];
        for (const p of parts) {
          if (p.inlineData?.data) {
            if (!state.tFirstAudio) state.tFirstAudio = Date.now();
            state.audioBytes += Buffer.from(p.inlineData.data, "base64").length;
          }
        }
        const ot = m?.serverContent?.outputTranscription?.text;
        if (ot) {
          if (!state.tFirstOutText) state.tFirstOutText = Date.now();
          state.textOut += ot;
        }
        if (m?.serverContent?.inputTranscription?.text) {
          if (!state.tFirstStt) state.tFirstStt = Date.now();
          state.stt += m.serverContent.inputTranscription.text;
        }
        if (m?.serverContent?.turnComplete) { state.tTurnDone = Date.now(); resolveDone(); }
      } else if (ev.type === "err") { state.err = ev.e; resolveDone(); }
    });

    // 실시간 입력처럼 청크 스트리밍 (100ms 분량 = 3,200바이트 @16kHz 16bit mono)
    const CHUNK = 3200;
    for (let off = 0; off < pcm.length; off += CHUNK) {
      s.sendRealtimeInput({ audio: { data: pcm.subarray(off, off + CHUNK).toString("base64"), mimeType: "audio/pcm;rate=16000" } });
      await new Promise((r) => setTimeout(r, 95)); // 실제 발화 속도 모사
    }
    s.sendRealtimeInput({ audioStreamEnd: true });
    state.tSendEnd = Date.now();

    await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
    try { s.close(); } catch {}

    const d = (t) => (t ? t - state.tSendEnd : -1);
    results.push({ audio: d(state.tFirstAudio), outText: d(state.tFirstOutText), stt: d(state.tFirstStt), total: d(state.tTurnDone) });
    console.log(`#${i + 1} "${text.slice(0, 18)}…" → 첫오디오 ${d(state.tFirstAudio)}ms · 첫출력전사 ${d(state.tFirstOutText)}ms · 입력전사 ${d(state.tFirstStt)}ms · 턴완료 ${d(state.tTurnDone)}ms · 오디오 ${(state.audioBytes / 48000).toFixed(1)}s분량`);
    console.log(`   STT: "${state.stt.trim().slice(0, 50)}" · 응답전사: "${state.textOut.trim().slice(0, 70)}"${state.err ? ` · ⚠ ${state.err}` : ""}`);
  }

  const ok = results.filter((r) => r.audio > 0);
  if (ok.length) {
    const avg = (k) => Math.round(ok.reduce((s, r) => s + r[k], 0) / ok.length);
    console.log(`\n===== 결과 (${ok.length}회 평균) =====`);
    console.log(`발화 종료 → 첫 오디오 청크: ${avg("audio")}ms  (즉시 재생 시 체감 첫 음성)`);
    console.log(`발화 종료 → 첫 출력 전사:  ${avg("outText")}ms  (안전망 게이트용 텍스트 도착)`);
    console.log(`발화 종료 → 입력 전사:     ${avg("stt")}ms  (인지분석 입력 가용 시점)`);
    console.log(`현행 경로 실측 6,100~6,500ms 대비 → 약 ${(((6100 - avg("audio")) / 6100) * 100).toFixed(0)}% 단축`);
  } else {
    console.log("\n⚠ 측정 실패 — 오디오 미수신");
  }
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
