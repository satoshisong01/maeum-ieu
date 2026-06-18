"use client";

/**
 * 라이브 음성 대화 (베타) — Gemini Live 직결 경로.
 * 실측 첫 음성 1.44s (현행 음성 6.1s). 안전망: 출력 전사 선행 게이트 + 턴 회송(/api/live/turn).
 * v1 제약: 검진(마음 건강 체크)은 이 화면에서 미지원 — 일반 대화 전용.
 * 테스트: ?fakemic=1 — 마이크 없이 window.__livePush(b64Pcm)/__liveEnd()로 주입(E2E).
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, Suspense } from "react";
import { LiveVoiceEngine } from "../chat/live-voice";
import { LogoutButton } from "../LogoutButton";

interface Bubble { role: "user" | "assistant"; text: string; final?: boolean }

function LiveInner() {
  const { status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const fakeMic = params.get("fakemic") === "1";

  const [state, setState] = useState<string>("idle");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [emergency, setEmergency] = useState(false);
  const [error, setError] = useState("");
  const engineRef = useRef<LiveVoiceEngine | null>(null);
  const convRef = useRef<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  useEffect(() => () => { engineRef.current?.stop(); }, []);

  const upsertBubble = (role: "user" | "assistant", text: string, final = false) => {
    setBubbles((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === role && !last.final) { last.text = text; last.final = final; return next; }
      next.push({ role, text, final });
      return next;
    });
  };

  const start = async () => {
    setError("");
    try {
      // 대화 확보 (기존 대화 이어쓰기 또는 생성)
      const getRes = await fetch("/api/conversations");
      const data = await getRes.json().catch(() => ({}));
      let convId: string | null = data?.conversation?.id ?? null;
      if (!convId) {
        const postRes = await fetch("/api/conversations", { method: "POST" });
        convId = (await postRes.json()).id;
      }
      convRef.current = convId;

      // 페르소나·전사 설정은 토큰 발급 시 서버가 고정 (Constrained 연결 — 클라 config 무시됨)
      const engine = new LiveVoiceEngine({
        onState: (s) => setState(s),
        onUserTranscript: (t) => upsertBubble("user", t),
        onAiTranscript: (t) => upsertBubble("assistant", t),
        onTurnComplete: async (u, a) => {
          upsertBubble("user", u, true); // 직전 두 버블 확정
          setBubbles((prev) => prev.map((b) => ({ ...b, final: true })));
          if (!convRef.current) return;
          try {
            const r = await fetch("/api/live/turn", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ conversationId: convRef.current, userText: u, aiText: a }),
            });
            const j = await r.json().catch(() => ({}));
            if (j.emergencyLevel === 3) setEmergency(true);
          } catch { /* 회송 실패 — 다음 턴에서 복구 */ }
        },
        onError: (m) => setError(m),
      });
      engineRef.current = engine;

      if (fakeMic) {
        // E2E 훅 노출
        (window as unknown as Record<string, unknown>).__livePush = (b64: string) => engine.injectPcm(b64);
        (window as unknown as Record<string, unknown>).__liveEnd = () => engine.endInjectedUtterance();
      }
      await engine.start({ fakeMic });
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  const stop = () => { engineRef.current?.stop(); setState("stopped"); };

  const stateLabel: Record<string, string> = {
    idle: "대기", connecting: "연결 중…", listening: "🎙 듣는 중", speaking: "🔊 말하는 중", stopped: "중지됨", error: "오류",
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#0e1b1e] text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <h1 className="text-base font-bold">🎙 라이브 음성 대화 <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px]">BETA</span></h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-teal-300">{stateLabel[state] ?? state}</span>
          <Link href="/chat" className="text-zinc-400 hover:text-zinc-200">기존 대화로</Link>
          <LogoutButton className="text-zinc-400 hover:text-zinc-200" />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-2 px-4 py-4">
        {emergency && (
          <p className="rounded-xl bg-red-600/90 px-4 py-3 text-sm font-bold">
            🚨 응급 징후가 감지되었어요. 지금 바로 119에 전화해 주세요. 보호자에게도 알려주세요.
          </p>
        )}
        {error && <p className="rounded-xl bg-amber-900/60 px-4 py-2 text-xs text-amber-200">{error}</p>}

        <div className="flex-1 space-y-2 overflow-y-auto">
          {bubbles.length === 0 && (
            <p className="pt-16 text-center text-sm text-zinc-500">
              시작을 누르고 말씀하세요. 말이 끝나면 한 박자 안에 대답해요.
              <br />(첫 음성 실측 1.4초 — 기존 6.1초)
            </p>
          )}
          {bubbles.map((b, i) => (
            <div key={i} className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${b.role === "user" ? "ml-auto bg-teal-700/80" : "bg-zinc-800"}`}>
              {b.text}
            </div>
          ))}
        </div>

        <div className="flex justify-center gap-3 py-3">
          {state !== "listening" && state !== "speaking" && state !== "connecting" ? (
            <button onClick={start} className="rounded-full bg-teal-500 px-8 py-4 text-lg font-bold text-zinc-950 hover:bg-teal-400">
              ▶ 시작
            </button>
          ) : (
            <button onClick={stop} className="rounded-full bg-zinc-700 px-8 py-4 text-lg font-bold hover:bg-zinc-600">
              ■ 중지
            </button>
          )}
        </div>
        <p className="pb-2 text-center text-[11px] text-zinc-500">
          베타: 이 화면은 일반 대화 전용이에요. 마음 건강 체크는 기존 대화 화면에서 해주세요.
        </p>
      </main>
    </div>
  );
}

export default function LivePage() {
  return <Suspense fallback={null}><LiveInner /></Suspense>;
}
