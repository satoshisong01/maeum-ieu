/**
 * T2 음성 왕복 지연 실측 — 자기 TTS로 합성한 음성을 /api/chat 음성 경로에 투입해
 * STT→첫 SSE chunk→done까지 단계별 타이밍 수집(STT∥프롬프트 병렬 효과 수치화).
 *
 * 사용: node scripts/measure-voice-latency.mjs [반복수=5]
 *   - DEBUG_TIMING=1 서버의 done.timings(sttMs/promptMs/ttfChunkMs 등)를 그대로 통계.
 *   - 로그인: cycle_test_2026@example.com (기존 테스트 계정)
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const N = parseInt(process.argv[2] || "5", 10);
const EMAIL = "cycle_test_2026@example.com";
const PW = "test1234!";

const UTTERANCES = [
  "오늘 날씨가 참 좋네",
  "아침에 미역국 끓여 먹었어",
  "무릎이 좀 시큰거리는데 괜찮겠지",
  "손주가 주말에 온다고 했어",
  "텃밭에 상추가 잘 자라고 있어",
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PW);
  await page.getByRole("button", { name: /로그인/ }).click();
  await page.waitForURL(/\/chat/, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const rows = [];
  for (let i = 0; i < N; i++) {
    const text = UTTERANCES[i % UTTERANCES.length];
    const timing = await page.evaluate(async (msg) => {
      // 1) 자기 TTS로 어르신 발화 합성 → 음성 입력 페이로드
      const tts = await fetch("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg }),
      });
      if (!tts.ok) return { error: `tts ${tts.status}` };
      const { audioBase64, mimeType } = await tts.json();

      // 2) 음성 경로 SSE 왕복 측정
      const t0 = performance.now();
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], audio: { data: audioBase64, mimeType } }),
      });
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/event-stream")) {
        const j = await res.json().catch(() => ({}));
        return { clientTotalMs: Math.round(performance.now() - t0), nonStream: true, keys: Object.keys(j) };
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let pending = "";
      let firstChunkAt = 0;
      let timings = null;
      let transcription = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += dec.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            if (ev.type === "chunk" && !firstChunkAt) firstChunkAt = performance.now() - t0;
            if (ev.type === "done") { timings = ev.timings || null; transcription = ev.transcription || ""; }
            if (ev.transcription && !transcription) transcription = ev.transcription;
          } catch {}
        }
      }
      return {
        clientTotalMs: Math.round(performance.now() - t0),
        clientFirstChunkMs: Math.round(firstChunkAt),
        server: timings, stt: transcription.slice(0, 30),
      };
    }, text);
    rows.push(timing);
    console.log(`#${i + 1} "${text}" → STT:"${timing.stt ?? "?"}" 첫chunk ${timing.clientFirstChunkMs ?? "-"}ms · 총 ${timing.clientTotalMs}ms · 서버 ${JSON.stringify(timing.server)}`);
    await page.waitForTimeout(800);
  }

  const ok = rows.filter((r) => r.clientFirstChunkMs);
  if (ok.length) {
    const avg = (k) => Math.round(ok.reduce((s, r) => s + (r[k] || 0), 0) / ok.length);
    console.log(`\n평균(${ok.length}회): 첫chunk ${avg("clientFirstChunkMs")}ms · 총 ${avg("clientTotalMs")}ms`);
    const sv = ok.filter((r) => r.server);
    if (sv.length) {
      const savg = (k) => Math.round(sv.reduce((s, r) => s + (r.server[k] || 0), 0) / sv.length);
      console.log(`서버 평균: stt ${savg("sttMs")}ms · prompt ${savg("promptMs")}ms · 첫chunk ${savg("ttfChunkMs")}ms · 총 ${savg("totalMs")}ms`);
    }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
