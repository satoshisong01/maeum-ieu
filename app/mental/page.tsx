"use client";

/**
 * T3 마음 건강 체크 — 본인용 결과 페이지 (점수·해석·추이 + 시작 안내).
 * 비진단 고지 + 위기 상담 안내 상시 노출.
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";

interface ResultRow { id: string; scale: string; scaleName?: string; maxTotal?: number; date: string; total: number; severity: string; crisis?: boolean; text: string; recommend: boolean }

const SEV_STYLE: Record<string, string> = {
  "정상": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "가벼운 수준": "bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-200",
  "중간 수준": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "다소 심한 수준": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  "심한 수준": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};

export default function MentalPage() {
  const { status } = useSession();
  const router = useRouter();
  const [results, setResults] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") { router.replace("/login"); return; }
    if (status !== "authenticated") return;
    fetch("/api/mental/results")
      .then((r) => r.json())
      .then((d) => setResults(d.results ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [status, router]);

  const latest = results[0];
  const maxTotal = 27;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">🧠 마음 건강</h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/chat" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">대화</Link>
            <Link href="/mypage" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">마이페이지</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5 dark:border-indigo-900 dark:bg-indigo-900/20">
          <h2 className="mb-1 text-sm font-semibold text-indigo-900 dark:text-indigo-200">검진 시작하기</h2>
          <p className="mb-3 text-xs text-indigo-700 dark:text-indigo-300">
            대화 화면에서 <b>&quot;마음 건강 체크&quot;</b>라고 말씀해 주세요. 9가지 질문에 답하면(약 5분) 결과가 이곳에 기록돼요.
            결과는 <b>본인만</b> 볼 수 있습니다.
          </p>
          <Link href="/chat" className="inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">대화로 이동 →</Link>
        </section>

        {loading && <p className="text-sm text-zinc-500">불러오는 중…</p>}

        {!loading && latest && (
          <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">최근 결과 — {latest.scaleName ?? "우울(PHQ-9)"} ({latest.date})</h2>
            <div className="flex items-center gap-4">
              <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">{latest.total}<span className="text-base font-normal text-zinc-400">/{latest.maxTotal ?? 27}</span></span>
              <span className={`rounded-full px-3 py-1 text-sm font-bold ${SEV_STYLE[latest.severity] ?? ""}`}>{latest.severity}</span>
            </div>
            {latest.crisis && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
                힘든 생각이 있다고 답해 주셨어요. 혼자 견디지 마세요 — 자살예방 ☎ 109 · 위기상담 ☎ 1577-0199 (24시간)
              </p>
            )}
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{latest.text}</p>
            {latest.recommend && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                전문가 상담을 권해요 — 정신건강복지센터 ☎ 1577-0199 (24시간)
              </p>
            )}
          </section>
        )}

        {!loading && results.length > 1 && (
          <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">추이</h2>
            <div className="flex h-24 items-end gap-2">
              {[...results].reverse().map((r) => (
                <div key={r.id} className="flex flex-1 flex-col items-center gap-1" title={`${r.total}점 (${r.severity})`}>
                  <div className={`w-full rounded-t ${r.total >= 10 ? "bg-orange-400" : r.total >= 5 ? "bg-amber-400" : "bg-emerald-400"}`}
                    style={{ height: `${Math.max(4, (r.total / maxTotal) * 80)}px` }} />
                  <span className="text-[10px] text-zinc-400">{r.date.slice(5)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {!loading && results.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            아직 검진 기록이 없어요. 위 안내대로 대화에서 시작해 보세요.
          </p>
        )}

        <footer className="mt-8 space-y-1 text-[11px] text-zinc-400">
          <p>· 이 결과는 의학적 진단이 아닌 자가 점검(PHQ-9 기반)이에요. 정확한 평가는 전문의와 상담해 주세요.</p>
          <p>· 마음이 많이 힘들 땐: 자살예방 상담전화 ☎ 109 · 정신건강 위기상담 ☎ 1577-0199 (24시간)</p>
        </footer>
      </main>
    </div>
  );
}
