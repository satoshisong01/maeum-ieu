"use client";

/**
 * 음성 대화 (Gemini Live 직결) — 어르신 기본 음성 화면.
 * 2026-07-20 본선 승격: 전화 통화 방식(한 번 시작하면 계속 대화), AI 먼저 인사,
 * 지난 대화 이어보기, 어르신용 큰 버튼·밝은 UI. 실측 첫 응답 1.3s.
 * 안전망: 출력 전사 선행 게이트(live-voice) + 턴 회송(/api/live/turn: 저장·응급·보호자알림·인지분석).
 * 제약: 검진(전문가)·마음 체크는 기존 화면(/chat) 전용.
 * 테스트: ?fakemic=1 — 마이크 없이 window.__livePush(b64Pcm)/__liveEnd()로 주입(E2E).
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, Suspense } from "react";
import { LiveVoiceEngine } from "../chat/live-voice";
import { LogoutButton } from "../LogoutButton";
import { isSessionEndUtterance } from "@/lib/chat/session-end";
import { classifyMedReply } from "@/lib/chat/medication";

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
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const engineRef = useRef<LiveVoiceEngine | null>(null);
  const convRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 무발화 단계 대응 — 기준은 "사용자" 발화(AI 혼잣말은 종료 타이머를 못 미룸: 공회전 과금 차단).
  //   60초: 민지가 먼저 한 마디(재참여 1) → 120초: 한 번 더(재참여 2) → 180초: 자동 종료([다시 대화하기]로 재개).
  const lastUserActivityRef = useRef(Date.now());
  const reEngageCountRef = useRef(0);
  // 복약 리마인더 — classic(/chat)과 동일 API(check→trigger→긍정답변 자동기록) 재사용
  const pendingMedRef = useRef<{ scheduleId: string; doseTime: string; ts: number } | null>(null);
  const stateRef = useRef("idle");

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  useEffect(() => () => { engineRef.current?.stop(); }, []);

  // 지난 대화 이어보기 — 최근 20개를 미리 표시 (대화 ID도 여기서 확보)
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/conversations");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data?.conversation?.id) {
          convRef.current = data.conversation.id;
          const msgs = (data.messages || []) as { role: string; content: string }[];
          setBubbles(msgs.slice(-20).map((m) => ({ role: m.role === "user" ? "user" as const : "assistant" as const, text: m.content, final: true })));
        }
      } catch { /* 이력 없이 시작 가능 */ }
      if (!cancelled) setHistoryLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [status]);

  // 새 버블 도착 시 하단 스크롤 유지
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles]);

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
    setEmergency(false);
    try {
      // 대화 확보 (이력 로드에서 못 얻었으면 생성)
      if (!convRef.current) {
        const postRes = await fetch("/api/conversations", { method: "POST" });
        convRef.current = (await postRes.json()).id;
      }

      // 페르소나·전사 설정은 토큰 발급 시 서버가 고정 (Constrained 연결 — 클라 config 무시됨)
      lastUserActivityRef.current = Date.now();
      reEngageCountRef.current = 0;
      const engine = new LiveVoiceEngine({
        onState: (s) => { stateRef.current = s; setState(s); },
        onUserTranscript: (t) => {
          lastUserActivityRef.current = Date.now();
          reEngageCountRef.current = 0; // 사용자가 말하면 재참여 단계 리셋
          upsertBubble("user", t);
        },
        onAiTranscript: (t) => upsertBubble("assistant", t),
        onTurnComplete: async (u, a) => {
          upsertBubble("user", u, true); // 직전 두 버블 확정
          setBubbles((prev) => prev.map((b) => ({ ...b, final: true })));
          if (convRef.current) {
            try {
              const r = await fetch("/api/live/turn", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationId: convRef.current, userText: u, aiText: a }),
              });
              const j = await r.json().catch(() => ({}));
              if (j.emergencyLevel === 3) setEmergency(true);
            } catch { /* 회송 실패 — 다음 턴에서 복구 */ }
          }
          // 복약 자동캡처 — 리마인더 후 긍정 답변이면 복용 기록(classic과 동일 로직·10분 만료)
          const pm = pendingMedRef.current;
          if (pm && u) {
            if (Date.now() - pm.ts > 10 * 60_000) pendingMedRef.current = null;
            else {
              const verdict = classifyMedReply(u);
              if (verdict !== "unclear") {
                pendingMedRef.current = null;
                if (verdict === "taken") {
                  fetch("/api/medications/check", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ scheduleId: pm.scheduleId, doseTime: pm.doseTime, status: "confirmed" }),
                  }).catch(() => { /* 무해화 */ });
                }
              }
            }
          }
          // 종료 명령("그만/이제 그만/조용히 해" 등) — 본선과 동일 패턴 모듈로 감지, 세션 종료
          if (isSessionEndUtterance(u)) {
            engineRef.current?.stop();
            setState("stopped");
          }
        },
        onError: (m) => setError(m),
      });
      engineRef.current = engine;

      if (fakeMic) {
        // E2E 훅 노출
        (window as unknown as Record<string, unknown>).__livePush = (b64: string) => engine.injectPcm(b64);
        (window as unknown as Record<string, unknown>).__liveEnd = () => engine.endInjectedUtterance();
      }
      await engine.start({ fakeMic, conversationId: convRef.current ?? undefined });
      engine.greet(); // AI가 먼저 인사
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  const stop = () => { engineRef.current?.stop(); setState("stopped"); };

  const active = state === "listening" || state === "speaking" || state === "connecting";

  // 무발화 단계 대응 (15초 주기): 60초 재참여1 → 120초 재참여2 → 180초 자동 종료.
  //   재참여는 AI가 말하고 있지 않을 때만 주입(자기 말 끊김 방지). 사용자 발화 기준이라
  //   민지의 재참여 발화 자체는 종료 타이머를 미루지 못함(공회전 과금 차단).
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const idleMs = Date.now() - lastUserActivityRef.current;
      if (idleMs > 180_000) {
        engineRef.current?.stop();
        setState("stopped");
        return;
      }
      const stage = idleMs > 120_000 ? 2 : idleMs > 60_000 ? 1 : 0;
      if (stage > reEngageCountRef.current && stateRef.current === "listening") {
        reEngageCountRef.current = stage;
        engineRef.current?.injectInstruction(
          "(사용자가 잠시 말이 없습니다. 프로필이나 지난 이야기에서 화제를 하나 골라 짧고 부드럽게 한 마디 건네보세요. 대답을 재촉하지 마세요.)",
        );
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [active]);

  // 복약/일과 알림 폴링 (60초) — classic(/chat)과 동일 API. due 발견 시 트리거(서버 dedup·저장)
  //   후 민지가 자연스럽게 말하도록 지시 주입. 긍정 답변 자동기록은 onTurnComplete에서.
  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || stateRef.current !== "listening") return; // AI 발화 중엔 다음 사이클로
      inFlight = true;
      try {
        const r = await fetch("/api/medications/check");
        if (!r.ok) return;
        const data = await r.json() as { due?: { scheduleId: string; label: string; slotTime: string }[] };
        const first = (data.due ?? [])[0];
        if (!first || !convRef.current) return;
        const tr = await fetch("/api/medications/trigger", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduleId: first.scheduleId, conversationId: convRef.current }),
        });
        if (!tr.ok) return;
        const trig = await tr.json() as { text?: string; skipped?: boolean };
        if (trig.skipped || !trig.text) return;
        pendingMedRef.current = { scheduleId: first.scheduleId, doseTime: first.slotTime, ts: Date.now() };
        engineRef.current?.injectInstruction(`(지금 복약 알림 시간입니다. 다음 내용을 자연스러운 말로 전해주세요: "${trig.text.replace(/"/g, "'")}")`);
      } catch { /* 다음 사이클 */ } finally { inFlight = false; }
    };
    const initial = setTimeout(tick, 5000);
    const interval = setInterval(tick, 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [active]);
  const stateLabel: Record<string, string> = {
    idle: "", connecting: "연결하고 있어요…", listening: "🎙 듣고 있어요 — 말씀하세요", speaking: "🔊 말하는 중이에요", stopped: "대화를 마쳤어요", error: "연결에 문제가 있어요",
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#f0f2f5] text-zinc-900 dark:bg-[#0b0d10] dark:text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-bold">🎤 음성 대화</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/chat" className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">⌨️ 글씨로 대화</Link>
          <Link href="/mypage" className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">⚙️ 마이페이지</Link>
          <LogoutButton className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200" />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-2 px-4 py-4">
        {emergency && (
          <p className="rounded-xl bg-red-600 px-4 py-3 text-base font-bold text-white">
            🚨 응급 징후가 감지되었어요. 지금 바로 119에 전화해 주세요. 보호자에게도 알려드렸어요.
          </p>
        )}
        {error && <p className="rounded-xl bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">{error}</p>}

        <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto">
          {historyLoaded && bubbles.length === 0 && (
            <p className="pt-16 text-center text-base text-zinc-500 dark:text-zinc-400">
              아래 [대화 시작하기]를 누르면
              <br />전화 통화하듯 편하게 이야기할 수 있어요.
            </p>
          )}
          {bubbles.map((b, i) => (
            <div key={i} className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[16px] leading-relaxed ${b.role === "user" ? "ml-auto bg-[#007bff] text-white" : "bg-white shadow-sm dark:bg-zinc-800"}`}>
              {b.text}
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center gap-2 py-3">
          {active && <p className="text-base font-semibold text-[#007bff] dark:text-blue-400">{stateLabel[state]}</p>}
          {!active ? (
            <button onClick={start} className="w-full max-w-sm rounded-full bg-[#28a745] px-8 py-5 text-xl font-bold text-white shadow-lg transition hover:bg-[#218838]">
              📞 {state === "stopped" ? "다시 대화하기" : "대화 시작하기"}
            </button>
          ) : (
            <button onClick={stop} className="w-full max-w-sm rounded-full bg-zinc-400 px-8 py-4 text-lg font-bold text-white shadow-md transition hover:bg-zinc-500 dark:bg-zinc-700 dark:hover:bg-zinc-600">
              그만하기
            </button>
          )}
          {active && <p className="text-sm text-zinc-500 dark:text-zinc-400">말씀 도중에 끼어들어도 되고, &ldquo;그만&rdquo; 하시면 끝나요.</p>}
        </div>
      </main>
    </div>
  );
}

export default function LivePage() {
  return <Suspense fallback={null}><LiveInner /></Suspense>;
}
