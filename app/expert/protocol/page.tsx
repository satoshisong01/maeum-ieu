"use client";

/**
 * 전문가 검진 문항지 — 검진에서 어떤 표준 문항을 어떤 근거(MMSE-K/MoCA-K/CIST)로 시행하는지
 * 미리 확인하는 참고 화면. 단일 출처(lib/screening/cist-bank)에서 렌더.
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ThemeToggle } from "../../theme-toggle";
import { LogoutButton } from "../../LogoutButton";
import { CIST_ITEMS, CIST_DOMAIN_ORDER, VOICE_MAX_POINTS } from "@/lib/screening/cist-bank";

export default function ProtocolPage() {
  const { status } = useSession();
  const router = useRouter();
  useEffect(() => { if (status === "unauthenticated") router.replace("/login"); }, [status, router]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">📋 검진 문항지 (전문가 확인용)</h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/expert" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">← 환자 관리</Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <section className="mb-5 rounded-2xl border border-teal-200 bg-teal-50 p-4 text-sm dark:border-teal-800 dark:bg-teal-900/20">
          <p className="font-semibold text-teal-900 dark:text-teal-200">표준 인지선별 — MMSE-K / MoCA-K / CIST 기준</p>
          <p className="mt-1 text-teal-800 dark:text-teal-300">
            검진 시작 시 AI 검사자가 아래 문항을 영역 순서대로 시행합니다. 음성 시행 가능 항목 총 <strong>{VOICE_MAX_POINTS}점</strong> 만점 환산.
            시공간(그리기)은 음성으로 시행 불가라 음성 검진에서는 생략됩니다(화면·지필 검사 시 별도).
          </p>
          <p className="mt-1 text-[12px] text-teal-700 dark:text-teal-400">검사 중에는 정답·힌트를 알려주지 않으며, 채점은 시스템이 합니다. 평균 소요 약 10~15분.</p>
        </section>

        <div className="space-y-4">
          {CIST_DOMAIN_ORDER.map(({ domain, label }, di) => {
            const items = CIST_ITEMS.filter((i) => i.domain === domain);
            if (items.length === 0) return null;
            const domainPoints = items.filter((i) => i.voice).reduce((s, i) => s + i.points, 0);
            const isVoice = items.some((i) => i.voice);
            return (
              <section key={domain} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{di + 1}. {label}</h2>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${isVoice ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"}`}>
                    {isVoice ? `${domainPoints}점` : "음성 미시행"}
                  </span>
                </div>
                <div className="space-y-2.5">
                  {items.map((it) => (
                    <div key={it.id} className={`rounded-xl px-3 py-2.5 ${it.voice ? "bg-zinc-50 dark:bg-zinc-800/50" : "bg-amber-50 dark:bg-amber-900/15"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm text-zinc-800 dark:text-zinc-100">{it.prompt}</p>
                        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-700 dark:text-zinc-300">{it.source}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <span className="font-semibold">{it.voice ? `배점 ${it.points}점` : "음성 미시행"}</span> · 채점: {it.scoring}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}
