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
import { LogoutButton } from "../../../LogoutButton";

interface DomainRow { domain: string; label: string; recentAvg: number | null; recentCount: number; baselineAvg: number | null; baselineCount: number }
interface WeekRow { weekStart: string; avg: number; count: number }
interface EventRow { date: string; domain: string; score: number; note: string | null; evidence: string | null }
interface Detail {
  patient: { name: string; age: number | null; gender: string | null };
  overallAvg: number | null; tier: string; tierText: string;
  reliability?: { reliable: boolean; provisional: boolean; showLevel: boolean };
  trend: string; trendText: string; trendDelta: number;
  domains: DomainRow[]; weekly: WeekRow[]; events: EventRow[];
  sessions?: { date: string; overallAvg: number | null; tier: string; count: number; domains: { label: string; avg: number }[] }[];
  medication?: { items: { id: string; label: string; times: string[]; enabled: boolean }[]; todayConfirmed: string[]; weekCompliance: { confirmed: number; expected: number } };
  cistEstimate?: { earned: number; max: number; assessedDomains: number } | null;
  examSessions?: { id: string; startedAt: string; endedAt: string | null; doctorComment: string; totalScore: number | null; maxScore: number | null; items: { itemId: string; domain: string; prompt: string; answer: string; score: number; max: number; reason: string }[]; qa: { role: string; content: string; at: string }[] }[];
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
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [savedComment, setSavedComment] = useState<string | null>(null);

  async function saveComment(sessionId: string, comment: string) {
    try {
      const r = await fetch("/api/expert/exam", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "comment", sessionId, comment }) });
      if (r.ok) { setSavedComment(sessionId); setTimeout(() => setSavedComment(null), 2000); }
    } catch { /* noop */ }
  }

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
            {params?.id && (
              <Link href={`/chat?patient=${params.id}`} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
                🩺 검사 시작
              </Link>
            )}
            <ThemeToggle />
            <Link href="/expert" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">← 환자 목록</Link>
            <LogoutButton />
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
                {data.reliability && !data.reliability.showLevel
                  ? <span className={`rounded-full px-3 py-1 text-sm font-bold ${TIER_STYLE["평가전"]}`}>평가중 · 자료 부족</span>
                  : <span className={`rounded-full px-3 py-1 text-sm font-bold ${TIER_STYLE[data.tier] ?? TIER_STYLE["평가전"]}`}>{data.tier}{data.reliability?.provisional ? " (잠정)" : ""}</span>}
                {data.overallAvg !== null && <span className="text-sm text-zinc-600 dark:text-zinc-300">7일 평균 {data.overallAvg}</span>}
              </div>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{data.trendText || data.tierText}</p>
              {data.reliability && !data.reliability.reliable && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                  {data.reliability.showLevel ? "※ 참고용 잠정 결과 — 대화·검진이 더 쌓이면 정확해집니다." : "※ 자료 부족 — 신뢰할 등급 산출 전입니다(최소 5회·2영역 필요)."}
                </p>
              )}
              {data.cistEstimate && (
                <div className="mt-3 rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                  <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    MMSE-K 환산 추정 <span className="text-base">{data.cistEstimate.earned}</span><span className="text-zinc-500">/{data.cistEstimate.max}점</span>
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
                    음성 시행 {data.cistEstimate.assessedDomains}개 영역의 정성 평가(0정상~2저하) 기반 추정치 — <strong>시공간(그리기)은 음성 미시행</strong>이라 만점에서 제외. 정식 MMSE-K/CIST 점수가 아니라 참고용이에요.
                  </p>
                </div>
              )}
            </section>

            {data.medication && data.medication.items.length > 0 && (
              <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">복약 · 오늘</h2>
                  {data.medication.weekCompliance.expected > 0 && (() => {
                    const pct = Math.round((data.medication.weekCompliance.confirmed / data.medication.weekCompliance.expected) * 100);
                    const tone = pct >= 80 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200" : pct >= 50 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200";
                    return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>이번 주 이행 {pct}%</span>;
                  })()}
                </div>
                <div className="grid gap-2">
                  {data.medication.items.map((m) => (
                    <div key={m.id} className={`rounded-xl px-3 py-2.5 ${m.enabled ? "bg-zinc-50 dark:bg-zinc-800/50" : "bg-zinc-50 opacity-60 dark:bg-zinc-800/30"}`}>
                      <div className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-100">{m.label}{!m.enabled && <span className="ml-1 text-xs text-zinc-400">(알림 꺼짐)</span>}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {m.times.map((tm) => {
                          const done = data.medication!.todayConfirmed.includes(`${m.id}|${tm}`);
                          return (
                            <span key={tm} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"}`}>
                              {done ? `✓ ${tm} 복용` : `${tm} 미확인`}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-zinc-400">어르신이 복용을 확인하면 ✓로 표시됩니다.</p>
              </section>
            )}

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

            {data.sessions && data.sessions.length > 0 && (
              <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-200">회차별 분석 (검사일 기준 · 최근 12회)</h2>
                <p className="mb-3 text-[11px] text-zinc-400">검사일마다 한 회차로 묶어 종합 점수(0 정상 ~ 2 주의)와 직전 회차 대비 변화를 봅니다.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-700">
                        <th className="py-1.5 pr-3 font-medium">검사일</th>
                        <th className="py-1.5 pr-3 font-medium">회차</th>
                        <th className="py-1.5 pr-3 font-medium">종합</th>
                        <th className="py-1.5 pr-3 font-medium">등급</th>
                        <th className="py-1.5 pr-3 font-medium">직전 대비</th>
                        <th className="py-1.5 font-medium">문항수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.map((s, i) => {
                        const round = data.sessions!.length - i; // 오래된 것이 1회차
                        const prev = data.sessions![i + 1]; // 더 오래된(직전) 회차
                        const delta = s.overallAvg !== null && prev?.overallAvg != null ? Number((s.overallAvg - prev.overallAvg).toFixed(2)) : null;
                        const deltaTxt = delta === null ? "—" : delta > 0.05 ? `▲ +${delta} 악화` : delta < -0.05 ? `▼ ${delta} 개선` : "= 비슷";
                        const deltaTone = delta === null ? "text-zinc-400" : delta > 0.05 ? "text-red-600 dark:text-red-300" : delta < -0.05 ? "text-green-600 dark:text-green-300" : "text-zinc-500";
                        return (
                          <tr key={s.date} className="border-b border-zinc-100 dark:border-zinc-800">
                            <td className="py-1.5 pr-3 text-zinc-700 dark:text-zinc-200">{s.date}</td>
                            <td className="py-1.5 pr-3 text-zinc-500">{round}회차</td>
                            <td className="py-1.5 pr-3 font-semibold text-zinc-800 dark:text-zinc-100">{s.overallAvg ?? "—"}</td>
                            <td className="py-1.5 pr-3"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${TIER_STYLE[s.tier] ?? TIER_STYLE["평가전"]}`}>{s.tier}</span></td>
                            <td className={`py-1.5 pr-3 font-medium ${deltaTone}`}>{deltaTxt}</td>
                            <td className="py-1.5 text-zinc-400">{s.count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {data.examSessions && data.examSessions.length > 0 && (
              <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-200">검진 문답 기록 · 의사 코멘트</h2>
                <p className="mb-3 text-[11px] text-zinc-400">검진 중 실제 질문과 환자 응답입니다. 직접 보시고 소견을 남기실 수 있어요(환자 일지).</p>
                <div className="space-y-4">
                  {data.examSessions.map((ex) => (
                    <div key={ex.id} className="rounded-xl border border-zinc-100 dark:border-zinc-800">
                      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                        <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{new Date(ex.startedAt).toLocaleString("ko-KR")}</span>
                        {ex.totalScore !== null && ex.maxScore
                          ? <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-bold text-teal-800 dark:bg-teal-900/40 dark:text-teal-200">정식 채점 {ex.totalScore}/{ex.maxScore}점</span>
                          : <span className="text-[11px] text-amber-600">{ex.endedAt ? "" : "진행 중"}</span>}
                      </div>
                      {ex.items.length > 0 && (
                        <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                          <p className="mb-1 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">항목별 채점 (시공간 음성 미시행 제외)</p>
                          <div className="flex flex-wrap gap-1">
                            {ex.items.map((it) => (
                              <span key={it.itemId} title={`${it.prompt} → ${it.answer} (${it.reason})`} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${it.score >= it.max ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200" : it.score > 0 ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200" : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200"}`}>
                                {it.itemId} {it.score}/{it.max}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="max-h-72 space-y-1.5 overflow-y-auto px-3 py-2">
                        {ex.qa.length === 0 && <p className="text-xs text-zinc-400">기록된 문답이 없습니다.</p>}
                        {ex.qa.map((m, i) => (
                          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                            <div className={`max-w-[85%] rounded-xl px-3 py-1.5 text-xs ${m.role === "user" ? "bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"}`}>
                              <span className="mr-1 text-[10px] font-semibold opacity-60">{m.role === "user" ? "환자" : "AI"}</span>{m.content}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                        <textarea
                          value={commentDrafts[ex.id] ?? ex.doctorComment}
                          onChange={(e) => setCommentDrafts((p) => ({ ...p, [ex.id]: e.target.value }))}
                          placeholder="의사 소견·코멘트 (환자 일지)"
                          rows={2}
                          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                        />
                        <div className="mt-1 flex items-center justify-end gap-2">
                          {savedComment === ex.id && <span className="text-[11px] font-medium text-teal-600">저장됨 ✓</span>}
                          <button type="button" onClick={() => saveComment(ex.id, commentDrafts[ex.id] ?? ex.doctorComment)} className="rounded-lg bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700">코멘트 저장</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

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
