"use client";

/**
 * 상시 감시 모드 (/observe) — 관찰자 모드 본체.
 * AI와 대화하지 않고, 등록된 환자 목소리만 상시 청취·전사·분석해 특이점(1차: 응급) 시 보호자에게 알림.
 * 화자 게이팅은 기기 안에서 수행 — 환자 목소리 조각만 서버로 전송, 다른 사람/잡음은 기기에서 폐기(제3자 녹음 회피).
 * ⚠ 반드시 사전 동의(환자·동거인) 후 사용. 화면에 상시 청취 중임을 명시.
 */
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LogoutButton, LogoutIcon } from "../LogoutButton";
import { VoiceMonitor } from "@/lib/voiceprint/monitor";
import { extractVoiceprintRobust, cosineSim, float32ToWavBase64, warmupVoiceprint } from "@/lib/voiceprint/client";

interface LogItem { at: string; kind: "patient" | "other" | "emergency"; text: string; score: number; level?: number }

export default function ObservePage() {
  const { status } = useSession();
  const router = useRouter();

  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [log, setLog] = useState<LogItem[]>([]);
  const [counts, setCounts] = useState({ patient: 0, other: 0 });
  const [emergency, setEmergency] = useState<string | null>(null);
  const [error, setError] = useState("");

  const printRef = useRef<number[] | null>(null);
  const thrRef = useRef(0.55);
  const monRef = useRef<VoiceMonitor | null>(null);
  const busyRef = useRef(false); // 조각 처리 중복 방지(직렬)

  useEffect(() => { if (status === "unauthenticated") router.replace("/login"); }, [status, router]);
  useEffect(() => () => { monRef.current?.stop(); }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    void warmupVoiceprint();
    fetch("/api/voiceprint?withEmbedding=1").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.enrolled && Array.isArray(d.embedding)) {
        printRef.current = d.embedding as number[];
        if (typeof d.threshold === "number") thrRef.current = d.threshold;
        setEnrolled(true);
      } else setEnrolled(false);
    }).catch(() => setEnrolled(false));
  }, [status]);

  const pushLog = (item: LogItem) => setLog((prev) => [item, ...prev].slice(0, 50));

  const handleSegment = async (audio: Float32Array) => {
    if (busyRef.current || !printRef.current) return;
    busyRef.current = true;
    try {
      const emb = await extractVoiceprintRobust(audio, 3, 1.5);
      const score = cosineSim(emb, printRef.current);
      const now = new Date().toLocaleTimeString();
      if (score < thrRef.current) {
        // 환자 아님(다른 사람/잡음) — 서버로 보내지 않고 폐기
        setCounts((c) => ({ ...c, other: c.other + 1 }));
        pushLog({ at: now, kind: "other", text: "(다른 사람/잡음 — 분석 안 함)", score });
        return;
      }
      // 환자 발화 — WAV로 서버 전송(전사·응급감지)
      setCounts((c) => ({ ...c, patient: c.patient + 1 }));
      const wav = float32ToWavBase64(audio);
      const res = await fetch("/api/observe/turn", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: wav, mimeType: "audio/wav" }),
      });
      const d = await res.json().catch(() => ({}));
      if (d?.skipped || !d?.text) {
        pushLog({ at: now, kind: "patient", text: "(잘 안 들림)", score });
        return;
      }
      const lvl = d.emergencyLevel ?? 0;
      pushLog({ at: now, kind: lvl >= 2 ? "emergency" : "patient", text: d.text, score, level: lvl });
      if (lvl >= 2) setEmergency(`응급 징후 감지 (레벨 ${lvl}) — 보호자에게 알림을 보냈어요.`);
    } catch (e) {
      console.warn("[observe] segment error", (e as Error).message);
    } finally {
      busyRef.current = false;
    }
  };

  const start = async () => {
    setError(""); setEmergency(null);
    const mon = new VoiceMonitor({
      onLevel: (l) => setLevel(l),
      onState: (s) => setSpeaking(s),
      onSegment: (audio) => { void handleSegment(audio); },
      onError: (m) => setError(m),
    });
    try { await mon.start(); monRef.current = mon; setRunning(true); }
    catch { setError("마이크를 사용할 수 없어요. 권한을 허용한 뒤 다시 시도해 주세요."); }
  };
  const stop = () => { monRef.current?.stop(); monRef.current = null; setRunning(false); setSpeaking(false); setLevel(0); };

  return (
    <div className="min-h-screen bg-[#0e1b1e] text-zinc-100">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-3">
        <h1 className="shrink-0 whitespace-nowrap text-base font-bold">👂 상시 감시 모드</h1>
        <nav className="flex shrink-0 items-center gap-1">
          <Link href="/live" title="음성 대화로" className="rounded-lg px-2 py-1.5 text-lg text-zinc-400 hover:bg-zinc-800">🎤</Link>
          <Link href="/mypage" title="설정" className="rounded-lg px-2 py-1.5 text-lg text-zinc-400 hover:bg-zinc-800">⚙️</Link>
          <LogoutButton title="로그아웃" className="rounded-lg px-2 py-1.5 text-zinc-400 hover:bg-zinc-800"><LogoutIcon className="h-5 w-5" /></LogoutButton>
        </nav>
      </header>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
        {emergency && (
          <div className="rounded-xl bg-red-600 px-4 py-3 text-base font-bold">🚨 {emergency}</div>
        )}
        {error && <p className="rounded-xl bg-amber-900/60 px-4 py-2 text-sm text-amber-200">{error}</p>}

        {enrolled === false && (
          <div className="rounded-2xl bg-zinc-800 p-5 text-center">
            <p className="text-base">상시 감시를 쓰려면 먼저 <b>환자 목소리 등록</b>이 필요해요.</p>
            <Link href="/voiceprint" className="mt-3 inline-block rounded-full bg-amber-500 px-6 py-3 font-bold text-zinc-950">🎙 목소리 등록하러 가기</Link>
          </div>
        )}

        {enrolled && (
          <>
            {/* 상태 카드 */}
            <div className="rounded-2xl bg-zinc-800 p-6 text-center">
              <p className={`text-lg font-bold ${running ? (speaking ? "text-teal-300" : "text-zinc-300") : "text-zinc-500"}`}>
                {running ? (speaking ? "🎙 듣는 중… (말소리 감지)" : "👂 대기 중… (조용함)") : "⏸ 감시 꺼짐"}
              </p>
              {/* 실시간 레벨바 */}
              <div className="mx-auto mt-3 h-3 max-w-xs overflow-hidden rounded-full bg-zinc-700">
                <div className="h-full bg-teal-400 transition-all duration-75" style={{ width: `${Math.min(100, Math.sqrt(level) * 160)}%` }} />
              </div>
              <p className="mt-3 text-sm text-zinc-400">환자 발화 {counts.patient}건 분석 · 그 외 {counts.other}건 무시</p>
            </div>

            {!running ? (
              <button onClick={start} className="w-full rounded-full bg-[#28a745] px-6 py-5 text-xl font-bold text-white shadow-lg">▶ 감시 시작</button>
            ) : (
              <button onClick={stop} className="w-full rounded-full bg-zinc-600 px-6 py-4 text-lg font-bold text-white">■ 감시 끄기</button>
            )}

            <p className="text-center text-xs text-zinc-500">
              등록된 환자 목소리만 분석해요. 다른 사람 말소리·잡음은 휴대폰에서 바로 버려지고 서버로 가지 않아요.<br />
              ⚠ 사용 전 환자·가족의 동의가 필요합니다.
            </p>

            {/* 관찰 로그 */}
            {log.length > 0 && (
              <div className="rounded-2xl bg-zinc-800/60 p-4">
                <p className="mb-2 text-xs font-semibold text-zinc-400">관찰 기록 (최근)</p>
                <ul className="space-y-1.5 text-sm">
                  {log.map((l, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="shrink-0 text-[10px] text-zinc-500">{l.at}</span>
                      <span className={`shrink-0 rounded px-1.5 text-[10px] font-semibold ${l.kind === "emergency" ? "bg-red-500 text-white" : l.kind === "patient" ? "bg-teal-700 text-teal-100" : "bg-zinc-700 text-zinc-400"}`}>
                        {l.kind === "emergency" ? `응급 L${l.level}` : l.kind === "patient" ? "환자" : "무시"}
                      </span>
                      <span className={l.kind === "other" ? "text-zinc-500" : ""}>{l.text} <span className="text-[10px] text-zinc-500">({(l.score * 100).toFixed(0)}%)</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
