"use client";

/**
 * 목소리 등록·확인 (/voiceprint) — 관찰자 모드 화자식별 테스트 화면.
 * 등록: ~20초 녹음 → 기기에서 성문 추출 → 서버 저장(벡터만).
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
import { extractVoiceprint, warmupVoiceprint, VOICEPRINT_THRESHOLD } from "@/lib/voiceprint/client";

const ENROLL_SECS = 20;
const TEST_SECS = 5;
const ENROLL_SCRIPT =
  "안녕하세요. 저는 오늘 날씨가 좋아서 기분이 참 좋습니다. 아침에는 밥을 먹고 산책을 다녀왔어요. " +
  "요즘 손주들이 자주 놀러 와서 즐겁습니다. 저녁에는 좋아하는 드라마를 보려고 합니다.";

function Inner() {
  const { status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const target = params.get("target") || undefined; // 보호자가 환자 대신 등록 시 ?target=<userId>

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "processing">("idle");
  const [mode, setMode] = useState<"enroll" | "test" | null>(null);
  const [remain, setRemain] = useState(0);
  const [enrolled, setEnrolled] = useState<{ updatedAt: string | null; sampleSecs: number | null } | null>(null);
  const [result, setResult] = useState<{ score: number; isSelf: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const recRef = useRef<VoiceRecorder | null>(null);

  useEffect(() => { if (status === "unauthenticated") router.replace("/login"); }, [status, router]);
  useEffect(() => { void warmupVoiceprint(); }, []);

  const qs = target ? `?targetUserId=${encodeURIComponent(target)}` : "";
  const loadStatus = () => {
    fetch(`/api/voiceprint${qs}`).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.enrolled) setEnrolled({ updatedAt: d.updatedAt, sampleSecs: d.sampleSecs });
      else setEnrolled(null);
    }).catch(() => {});
  };
  useEffect(() => { if (status === "authenticated") loadStatus(); }, [status]);

  const record = async (secs: number): Promise<Float32Array | null> => {
    setMsg("");
    const rec = new VoiceRecorder();
    recRef.current = rec;
    try {
      await rec.start();
    } catch {
      setMsg("마이크를 사용할 수 없어요. 권한을 허용한 뒤 다시 시도해 주세요.");
      return null;
    }
    setPhase("recording");
    for (let s = secs; s > 0; s--) {
      setRemain(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setPhase("processing");
    const { audio } = await rec.stop();
    recRef.current = null;
    return audio;
  };

  const doEnroll = async () => {
    setBusy(true); setMode("enroll"); setResult(null);
    try {
      const audio = await record(ENROLL_SECS);
      if (!audio) return;
      const embedding = await extractVoiceprint(audio);
      const res = await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enroll", embedding, dim: embedding.length, sampleSecs: audio.length / 16000, targetUserId: target }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "등록 실패");
      setMsg("목소리 등록이 완료됐어요.");
      loadStatus();
    } catch (e) {
      setMsg(`오류: ${(e as Error).message}`);
    } finally {
      setBusy(false); setPhase("idle"); setMode(null);
    }
  };

  const doTest = async () => {
    setBusy(true); setMode("test"); setResult(null);
    try {
      const audio = await record(TEST_SECS);
      if (!audio) return;
      const embedding = await extractVoiceprint(audio);
      const res = await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", embedding, targetUserId: target }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "확인 실패");
      setResult({ score: d.score, isSelf: d.isSelf });
    } catch (e) {
      setMsg(`오류: ${(e as Error).message}`);
    } finally {
      setBusy(false); setPhase("idle"); setMode(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#f0f2f5] text-zinc-900 dark:bg-[#0b0d10] dark:text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-bold">🎙 목소리 등록·확인</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/chat" className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">대화 화면</Link>
          <LogoutButton className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200" />
        </div>
      </header>

      <main className="mx-auto max-w-lg space-y-5 px-4 py-6">
        {phase !== "idle" && (
          <div className="rounded-2xl bg-[#007bff] px-6 py-8 text-center text-white shadow-lg">
            {phase === "recording"
              ? <><p className="text-lg font-bold">🔴 녹음 중… {remain}초</p><p className="mt-1 text-sm opacity-90">{mode === "enroll" ? "아래 문장을 편하게 읽어 주세요" : "아무 말이나 편하게 해 주세요"}</p></>
              : <p className="text-lg font-bold">🧠 목소리를 분석하고 있어요…</p>}
          </div>
        )}

        {msg && <p className="rounded-xl bg-white px-4 py-3 text-sm shadow-sm dark:bg-zinc-800">{msg}</p>}

        {/* 등록 */}
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
          <h2 className="text-base font-bold">① 목소리 등록</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {enrolled
              ? `등록됨 · ${enrolled.updatedAt ? new Date(enrolled.updatedAt).toLocaleDateString() : ""}${enrolled.sampleSecs ? ` (${Math.round(enrolled.sampleSecs)}초)` : ""} — 다시 등록하면 갱신돼요`
              : "아직 등록 전이에요. 20초 동안 목소리를 녹음해 등록합니다."}
          </p>
          <div className="mt-3 rounded-xl bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            “{ENROLL_SCRIPT}”
          </div>
          <button
            onClick={doEnroll}
            disabled={busy}
            className="mt-4 w-full rounded-full bg-[#28a745] px-6 py-4 text-lg font-bold text-white shadow disabled:opacity-50"
          >
            {enrolled ? "🎙 다시 등록하기" : "🎙 등록 시작 (20초)"}
          </button>
        </section>

        {/* 확인 */}
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
          <h2 className="text-base font-bold">② 목소리 확인 테스트</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            5초 녹음해서 등록한 목소리와 같은 사람인지 확인해요. 본인·다른 사람 목소리로 각각 해 보세요.
          </p>
          <button
            onClick={doTest}
            disabled={busy || !enrolled}
            className="mt-3 w-full rounded-full bg-[#007bff] px-6 py-4 text-lg font-bold text-white shadow disabled:opacity-50"
          >
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
