"use client";

/**
 * 전문가용 환자 상세 리포트 — 영역별 7일/30일 비교, 8주 추이, 이상 이벤트(분석기 임상 근거).
 * 대화 원문은 표시하지 않음(프라이버시 기본값).
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../../../theme-toggle";

interface DomainRow { domain: string; label: string; recentAvg: number | null; recentCount: number; baselineAvg: number | null; baselineCount: number }
interface WeekRow { weekStart: string; avg: number; count: number }
interface EventRow { date: string; domain: string; score: number; note: string | null; evidence: string | null }
interface Detail {
  patient: { name: string; age: number | null; gender: string | null };
  overallAvg: number | null; tier: string; tierText: string;
  trend: string; trendText: string; trendDelta: number;
  domains: DomainRow[]; weekly: WeekRow[]; events: EventRow[];
}

const TIER_STYLE: Record<string, string> = {
  "정상": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "경증": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "중증": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  "고위험": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "평가전": "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};
const scoreColor = (v: number | null) => v === null ? "bg-zinc-200 dark:bg-zinc-700" : v >= 1.5 ? "bg-red-400" : v >= 0.8 ? "bg-orange-400" : v >= 0.3 ? "bg-amber-400" : "bg-emerald-400";

export default function PatientDetailPage() {
  const { status } = useSession();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") { router.replace("/login"); return; }
    if (status !== "authenticated" || !params?.id) return;
    fetch(`/api/expert/patients/${params.id}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) { setError(d.error ?? "불러오지 못했습니다."); return; }
        setData(d);
      })
      .catch(() => setError("불러오지 못했습니다. 새로고침해 주세요."));
  }, [status, params, router]);

  const maxWeekly = data ? Math.max(0.5, ...data.weekly.map((w) => w.avg)) : 1;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">🩺 환자 리포트</h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/expert" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">← 환자 목록</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
        {!error && !data && <p className="text-sm text-zinc-500">불러오는 중…</p>}
        {data && (
          <>
            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{data.patient.name}</span>
                <span className="text-sm text-zinc-500">{data.patient.age ? `${data.patient.age}세` : ""} {data.patient.gender === "male" ? "남" : data.patient.gender === "female" ? "여" : ""}</span>
                <span className={`rounded-full px-3 py-1 text-sm font-bold ${TIER_STYLE[data.tier] ?? TIER_STYLE["평가전"]}`}>{data.tier}</span>
                {data.overallAvg !== null && <span className="text-sm text-zinc-600 dark:text-zinc-300">7일 평균 {data.overallAvg}</span>}
              </div>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{data.trendText || data.tierText}</p>
            </section>

            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">영역별 점수 — 최근 7일 vs 이전 30일 (0 정상 ~ 2 주의)</h2>
              <div className="grid gap-2">
                {data.domains.map((d) => (
                  <div key={d.domain} className="flex items-center gap-3 text-xs">
                    <span className="w-24 shrink-0 font-medium text-zinc-600 dark:text-zinc-300">{d.label}</span>
                    <div className="flex flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                          <div className={`h-full ${scoreColor(d.recentAvg)}`} style={{ width: `${Math.min(100, ((d.recentAvg ?? 0) / 2) * 100)}%` }} />
                        </div>
                        <span className="w-20 shrink-0 text-zinc-500">7일 {d.recentAvg ?? "—"} ({d.recentCount})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                          <div className="h-full bg-zinc-400 dark:bg-zinc-500" style={{ width: `${Math.min(100, ((d.baselineAvg ?? 0) / 2) * 100)}%` }} />
                        </div>
                        <span className="w-20 shrink-0 text-zinc-400">30일 {d.baselineAvg ?? "—"} ({d.baselineCount})</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">주간 추이 (8주)</h2>
              {data.weekly.length === 0 && <p className="text-xs text-zinc-400">평가 데이터가 없습니다.</p>}
              <div className="flex h-24 items-end gap-2">
                {data.weekly.map((w) => (
                  <div key={w.weekStart} className="flex flex-1 flex-col items-center gap-1">
                    <div className={`w-full rounded-t ${scoreColor(w.avg)}`} style={{ height: `${Math.max(4, (w.avg / maxWeekly) * 80)}px` }} title={`${w.avg} (${w.count}건)`} />
                    <span className="text-[10px] text-zinc-400">{w.weekStart.slice(5)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-200">최근 이상 이벤트 (분석기 기록 · 최대 20건)</h2>
              <p className="mb-3 text-[11px] text-zinc-400">분석 근거 요약만 표시됩니다 — 대화 원문은 환자 프라이버시 보호를 위해 공개되지 않습니다.</p>
              {data.events.length === 0 && <p className="text-xs text-zinc-400">이상 이벤트가 없습니다.</p>}
              <div className="grid gap-2">
                {data.events.map((e, i) => (
                  <div key={i} className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-800/50">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-400">{e.date}</span>
                      <span className="font-semibold text-zinc-700 dark:text-zinc-200">{e.domain}</span>
                      <span className={`rounded px-1.5 py-0.5 font-bold ${e.score >= 2 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"}`}>{e.score}점</span>
                    </div>
                    {(e.note || e.evidence) && <p className="mt-1 text-zinc-500 dark:text-zinc-400">{e.note || e.evidence}</p>}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
