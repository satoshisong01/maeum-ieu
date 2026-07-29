"use client";

/**
 * 목소리 등록·확인 (/voiceprint) — 관찰자 모드 화자식별 테스트 화면.
 * 등록: 다양한 문장을 여러 번 녹음해 표본 누적(지문 다회 등록과 동일 원리) → 표본 평균이 대표 성문.
 * 확인: ~5초 녹음 → 성문 대조 → 유사도·본인여부 표시.
 * 원음성은 기기를 떠나지 않음(온디바이스 추출).
 */
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { LogoutButton } from "../LogoutButton";
import { VoiceRecorder } from "@/lib/voiceprint/recorder";
import { extractVoiceprintRobust, warmupVoiceprint, VOICEPRINT_THRESHOLD } from "@/lib/voiceprint/client";

const ENROLL_SECS = 8;   // 표본당 녹음 길이(문장 하나 낭독)
const TEST_SECS = 5;
const RECOMMEND_SAMPLES = 5; // 권장 표본 수(이 이상이면 충분)

// 발음(받침·모음·자음·숫자)을 고루 담은 다양한 표본 문장 — 표본마다 다른 것을 로테이션
const ENROLL_SENTENCES = [
  "안녕하세요, 오늘 날씨가 참 맑고 좋네요.",
  "아침에 미역국이랑 김치를 먹었더니 속이 든든합니다.",
  "우리 손주가 여덟 살인데 벌써 글씨를 잘 씁니다.",
  "빨간 우산을 쓰고 파란 대문 앞에서 기다렸어요.",
  "숫자를 세어 볼게요. 하나, 둘, 셋, 넷, 다섯, 여섯.",
  "봄에는 벚꽃, 여름에는 수박, 가을에는 단풍이 좋지요.",
  "동네 병원에 다녀오는 길에 약국도 들렀습니다.",
  "따뜻한 커피 한 잔 마시며 라디오를 들었어요.",
];

function Inner() {
  const { status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const target = params.get("target") || undefined;

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "processing">("idle");
  const [mode, setMode] = useState<"enroll" | "test" | null>(null);
  const [remain, setRemain] = useState(0);
  const [sampleCount, setSampleCount] = useState(0);
  const [result, setResult] = useState<{ score: number; isSelf: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [levels, setLevels] = useState<number[]>([]); // 실시간 음량 파형(최근 값)
  const recRef = useRef<VoiceRecorder | null>(null);

  const BARS = 28;
  const MIN_PEAK = 0.03; // 이보다 낮으면 사실상 무음/저음량 — 성문이 배경만 학습

  const sentence = ENROLL_SENTENCES[sampleCount % ENROLL_SENTENCES.length];

  useEffect(() => { if (status === "unauthenticated") router.replace("/login"); }, [status, router]);
  useEffect(() => { void warmupVoiceprint(); }, []);

  const loadStatus = () => {
    const qs = target ? `?targetUserId=${encodeURIComponent(target)}` : "";
    fetch(`/api/voiceprint${qs}`).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d) setSampleCount(d.sampleCount ?? 0);
    }).catch(() => {});
  };
  useEffect(() => { if (status === "authenticated") loadStatus(); }, [status]);

  const record = async (secs: number): Promise<{ audio: Float32Array; peak: number } | null> => {
    setMsg("");
    setLevels([]);
    const rec = new VoiceRecorder();
    recRef.current = rec;
    try {
      await rec.start((level) => {
        // 실시간 파형 — 오른쪽에서 밀려 들어오는 막대(로그 스케일로 잘 보이게)
        setLevels((prev) => {
          const v = Math.min(1, Math.sqrt(level) * 1.6);
          const next = prev.length >= BARS ? prev.slice(1) : prev.slice();
          next.push(v);
          return next;
        });
      });
    }
    catch { setMsg("마이크를 사용할 수 없어요. 권한을 허용한 뒤 다시 시도해 주세요."); return null; }
    setPhase("recording");
    for (let s = secs; s > 0; s--) { setRemain(s); await new Promise((r) => setTimeout(r, 1000)); }
    setPhase("processing");
    const { audio, peak } = await rec.stop();
    recRef.current = null;
    return { audio, peak };
  };

  const doEnroll = async () => {
    setBusy(true); setMode("enroll"); setResult(null);
    try {
      const rec = await record(ENROLL_SECS);
      if (!rec) return;
      if (rec.peak < MIN_PEAK) { setMsg("🔇 목소리가 거의 안 들렸어요. 마이크에 가까이, 또박또박 다시 읽어 주세요. (이 표본은 저장하지 않았어요)"); return; }
      const { audio } = rec;
      const embedding = await extractVoiceprintRobust(audio, 3, 1.5);
      const res = await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enroll", embedding, sampleSecs: audio.length / 16000, targetUserId: target }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "등록 실패");
      setSampleCount(d.sampleCount ?? sampleCount + 1);
      setMsg(`표본 ${d.sampleCount}개 등록됨${d.sampleCount >= RECOMMEND_SAMPLES ? " — 충분해요! 이제 확인 테스트를 해보세요." : ` — ${RECOMMEND_SAMPLES}개 이상 권장`}`);
    } catch (e) { setMsg(`오류: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase("idle"); setMode(null); }
  };

  const doReset = async () => {
    setBusy(true);
    try {
      await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", targetUserId: target }),
      });
      setSampleCount(0); setResult(null); setMsg("등록을 초기화했어요. 처음부터 다시 등록할 수 있어요.");
    } finally { setBusy(false); }
  };

  const doTest = async () => {
    setBusy(true); setMode("test"); setResult(null);
    try {
      const rec = await record(TEST_SECS);
      if (!rec) return;
      if (rec.peak < MIN_PEAK) { setMsg("🔇 목소리가 거의 안 들렸어요. 마이크에 가까이 다시 말씀해 주세요."); return; }
      const { audio } = rec;
      const embedding = await extractVoiceprintRobust(audio, 3, 1.5);
      const res = await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", embedding, targetUserId: target }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "확인 실패");
      setResult({ score: d.score, isSelf: d.isSelf });
    } catch (e) { setMsg(`오류: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase("idle"); setMode(null); }
  };

  const enrolled = sampleCount > 0;

  return (
    <div className="min-h-screen bg-[#f0f2f5] text-zinc-900 dark:bg-[#0b0d10] dark:text-zinc-100">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="shrink-0 whitespace-nowrap text-base font-bold">🎙 목소리 등록·확인</h1>
        <nav className="flex shrink-0 items-center gap-1">
          <Link href="/chat" title="대화 화면" className="rounded-lg px-2 py-1.5 text-lg text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">💬</Link>
          <LogoutButton title="로그아웃" className="rounded-lg px-2 py-1.5 text-lg text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">🚪</LogoutButton>
        </nav>
      </header>

      <main className="mx-auto max-w-lg space-y-5 px-4 py-6">
        {phase !== "idle" && (
          <div className="rounded-2xl bg-[#007bff] px-6 py-6 text-center text-white shadow-lg">
            {phase === "recording" ? (
              <>
                <p className="text-lg font-bold">🔴 녹음 중… {remain}초</p>
                {/* 실시간 음파 — 말하면 막대가 커져요 */}
                <div className="mx-auto mt-3 flex h-16 max-w-xs items-center justify-center gap-[3px]">
                  {Array.from({ length: BARS }).map((_, i) => {
                    const v = levels[i] ?? 0;
                    return <span key={i} className="w-1.5 rounded-full bg-white/90 transition-all duration-75" style={{ height: `${Math.max(6, v * 100)}%` }} />;
                  })}
                </div>
                <p className="mt-2 text-sm opacity-90">{mode === "enroll" ? "아래 문장을 또박또박 읽어 주세요" : "아무 말이나 편하게 해 주세요"}</p>
              </>
            ) : <p className="text-lg font-bold">🧠 목소리를 분석하고 있어요…</p>}
          </div>
        )}

        {msg && <p className="rounded-xl bg-white px-4 py-3 text-sm shadow-sm dark:bg-zinc-800">{msg}</p>}

        {/* 등록 */}
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">① 목소리 등록</h2>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${sampleCount >= RECOMMEND_SAMPLES ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}>
              표본 {sampleCount} / {RECOMMEND_SAMPLES}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            지문 등록처럼 <b>여러 번 녹음할수록 정확</b>해져요. 매번 <b>다른 문장</b>을 8초씩 읽어 주세요. (5개 이상 권장)
          </p>
          {/* 진행 바 */}
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div className="h-full bg-green-500 transition-all" style={{ width: `${Math.min(100, (sampleCount / RECOMMEND_SAMPLES) * 100)}%` }} />
          </div>
          <div className="mt-3 rounded-xl bg-zinc-50 px-4 py-4 text-center text-base font-medium leading-relaxed text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            “{sentence}”
          </div>
          <button onClick={doEnroll} disabled={busy} className="mt-4 w-full rounded-full bg-[#28a745] px-6 py-4 text-lg font-bold text-white shadow disabled:opacity-50">
            🎙 {enrolled ? `표본 추가하기 (${sampleCount + 1}번째, 8초)` : "등록 시작 (8초)"}
          </button>
          {enrolled && (
            <button onClick={doReset} disabled={busy} className="mt-2 w-full text-center text-xs text-zinc-400 underline hover:text-zinc-600 dark:hover:text-zinc-300">
              등록 초기화(처음부터)
            </button>
          )}
        </section>

        {/* 확인 */}
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
          <h2 className="text-base font-bold">② 목소리 확인 테스트</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            5초 녹음해서 등록한 목소리와 같은 사람인지 확인해요. 본인·다른 사람 목소리로 각각 해 보세요.
          </p>
          <button onClick={doTest} disabled={busy || !enrolled} className="mt-3 w-full rounded-full bg-[#007bff] px-6 py-4 text-lg font-bold text-white shadow disabled:opacity-50">
            {enrolled ? "🎙 확인 테스트 (5초)" : "먼저 등록해 주세요"}
          </button>
          {result && (
            <div className="mt-4 rounded-xl border p-4 text-center dark:border-zinc-700">
              <p className={`text-2xl font-extrabold ${result.isSelf ? "text-green-600" : "text-red-500"}`}>
                {result.isSelf ? "✅ 본인 목소리" : "❌ 다른 사람"}
              </p>
              <p className="mt-1 text-sm text-zinc-500">유사도 {(result.score * 100).toFixed(0)}% (기준 {(VOICEPRINT_THRESHOLD * 100).toFixed(0)}%)</p>
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div className={`h-full ${result.isSelf ? "bg-green-500" : "bg-red-400"}`} style={{ width: `${Math.max(0, Math.min(100, result.score * 100))}%` }} />
              </div>
            </div>
          )}
        </section>

        <p className="text-center text-xs text-zinc-400">
          목소리 원본은 휴대폰을 벗어나지 않아요 — 분석한 특징값만 안전하게 저장됩니다.
        </p>
      </main>
    </div>
  );
}

export default function VoiceprintPage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
