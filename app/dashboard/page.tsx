"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import Link from "next/link";

interface CognitiveAssessment {
  domain: string; score: number; confidence: number;
  evidence: string | null; note: string | null; session_date: string;
}
interface DomainAvg { domain: string; avg_score: number; count: number; }
interface DailyTrend { session_date: string; avg_score: number; check_count: number; normal: number; borderline: number; warning: number; }
interface Summary { anomalyCount: number; recentAnomaly: number; }
interface CognitiveData { assessments: CognitiveAssessment[]; domainAverages: DomainAvg[]; dailyTrend: DailyTrend[]; }

const DOMAIN_LABELS: Record<string, string> = {
  orientation_time: "시간 지남력", orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억력", memory_delayed: "지연 기억력",
  language: "언어 유창성", judgment: "판단력",
  attention_calculation: "주의력/계산",
};
const SCORE_LABELS = ["정상", "경계", "주의"];
const SCORE_COLORS = ["bg-green-500", "bg-yellow-500", "bg-red-500"];
const SCORE_TEXT = ["text-green-600", "text-yellow-600", "text-red-600"];

function formatShortDate(d: string): string {
  return new Date(d + "T00:00:00+09:00").toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" });
}

export default function DashboardPage() {
  const { status } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cognitive, setCognitive] = useState<CognitiveData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status !== "authenticated") return;
    (async () => {
      try {
        const res = await fetch("/api/health-logs");
        if (!res.ok) return;
        const data = await res.json();
        setSummary(data.summary ?? null);
        setCognitive(data.cognitive ?? null);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, [status]);

  if (status === "loading" || loading) {
    return <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5]"><p className="text-zinc-500">로딩 중...</p></div>;
  }

  const totalChecks = cognitive?.domainAverages.reduce((s, d) => s + d.count, 0) ?? 0;
  const overallAvg = totalChecks > 0 ? cognitive!.domainAverages.reduce((s, d) => s + d.avg_score * d.count, 0) / totalChecks : -1;
  const oi = overallAvg < 0 ? -1 : overallAvg < 0.5 ? 0 : overallAvg < 1.5 ? 1 : 2;

  // CDR 기반 종합 위험도 등급
  const getCdrLevel = (avg: number): { level: string; desc: string; color: string; bgColor: string } => {
    if (avg < 0) return { level: "-", desc: "아직 평가 데이터가 부족합니다", color: "text-zinc-400", bgColor: "bg-zinc-50" };
    if (avg < 0.3) return { level: "CDR 0", desc: "정상 — 인지 기능에 특이 사항이 없습니다", color: "text-green-700", bgColor: "bg-green-50" };
    if (avg < 0.8) return { level: "CDR 0.5", desc: "치매 의심 — 경미한 인지 변화가 관찰됩니다. 정밀 검사를 권장합니다", color: "text-yellow-700", bgColor: "bg-yellow-50" };
    if (avg < 1.5) return { level: "CDR 1", desc: "경도 치매 의심 — 일상생활에 영향을 줄 수 있는 인지 저하가 관찰됩니다. 전문의 상담을 강력히 권장합니다", color: "text-orange-700", bgColor: "bg-orange-50" };
    return { level: "CDR 2+", desc: "중등도 이상 치매 의심 — 즉시 전문의 상담이 필요합니다", color: "text-red-700", bgColor: "bg-red-50" };
  };
  const cdr = getCdrLevel(overallAvg);

  // 영역별 취약 분석
  const weakDomains = (cognitive?.domainAverages ?? [])
    .filter((d) => d.avg_score >= 1.0 && d.count >= 2)
    .sort((a, b) => b.avg_score - a.avg_score);

  return (
    <div className="min-h-screen bg-[#f0f2f5]">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-800">건강 모니터링</h1>
        <Link href="/chat" className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">대화로 돌아가기</Link>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* 요약 카드 */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">인지 종합</p>
            <p className={`text-xl font-bold ${oi < 0 ? "text-zinc-400" : SCORE_TEXT[oi]}`}>{oi < 0 ? "미평가" : SCORE_LABELS[oi]}</p>
            {overallAvg >= 0 && <p className="text-xs text-zinc-400">{overallAvg.toFixed(1)} / 2.0</p>}
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">총 평가</p>
            <p className="text-xl font-bold text-zinc-800">{totalChecks}회</p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">이상 징후 (7일)</p>
            <p className={`text-xl font-bold ${(summary?.recentAnomaly ?? 0) > 0 ? "text-red-600" : "text-green-600"}`}>{summary?.recentAnomaly ?? 0}건</p>
          </div>
        </div>

        {/* CDR 종합 위험도 등급 */}
        <div className={`mb-6 rounded-xl p-4 shadow-sm ${cdr.bgColor}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-zinc-500">종합 위험도 (CDR 기반)</p>
              <p className={`text-2xl font-bold ${cdr.color}`}>{cdr.level}</p>
            </div>
            {totalChecks >= 5 && overallAvg >= 0.8 && (
              <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">전문의 상담 권장</span>
            )}
          </div>
          <p className={`mt-2 text-sm ${cdr.color}`}>{cdr.desc}</p>
          {totalChecks < 10 && <p className="mt-1 text-xs text-zinc-400">* 평가 횟수가 적어 정확도가 낮을 수 있습니다 (현재 {totalChecks}회)</p>}
        </div>

        {/* 취약 영역 안내 */}
        {weakDomains.length > 0 && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">주의가 필요한 영역</h2>
            <div className="space-y-2">
              {weakDomains.map((d) => (
                <div key={d.domain} className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-2">
                  <span className="text-sm font-medium text-red-700">{DOMAIN_LABELS[d.domain] ?? d.domain}</span>
                  <span className="text-xs text-red-600">평균 {d.avg_score.toFixed(1)} ({d.count}회 평가)</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 영역별 점수 */}
        {cognitive && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-zinc-700">영역별 인지 점수</h2>
            <div className="space-y-3">
              {Object.keys(DOMAIN_LABELS).map((domain) => {
                const item = cognitive.domainAverages.find((d) => d.domain === domain);
                const avg = item?.avg_score ?? -1;
                const ci = avg < 0 ? -1 : avg < 0.5 ? 0 : avg < 1.5 ? 1 : 2;
                return (
                  <div key={domain}>
                    <div className="mb-1 flex justify-between">
                      <span className="text-sm text-zinc-700">{DOMAIN_LABELS[domain]}</span>
                      <span className={`text-xs font-medium ${ci < 0 ? "text-zinc-400" : SCORE_TEXT[ci]}`}>
                        {ci < 0 ? "미평가" : `${avg.toFixed(1)} (${item!.count}회)`}
                      </span>
                    </div>
                    <div className="h-3 rounded-full bg-zinc-100">
                      {ci >= 0 && <div className={`h-full rounded-full ${SCORE_COLORS[ci]}`} style={{ width: `${Math.max(5, (avg / 2) * 100)}%` }} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-zinc-400">0.0=정상 | 1.0=경계 | 2.0=주의</p>
          </div>
        )}

        {/* 14일 추세 — 이상 비율 + 스택 바 */}
        {cognitive && cognitive.dailyTrend.length > 0 && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-zinc-700">최근 14일 추세</h2>
            <div className="space-y-4">
              {cognitive.dailyTrend.map((d) => {
                const total = d.check_count;
                const normalPct = total > 0 ? Math.round((d.normal / total) * 100) : 0;
                const borderPct = total > 0 ? Math.round((d.borderline / total) * 100) : 0;
                const warningPct = total > 0 ? Math.round((d.warning / total) * 100) : 0;
                const anomalyPct = borderPct + warningPct;
                return (
                  <div key={d.session_date}>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-sm font-medium text-zinc-700">{formatShortDate(d.session_date)}</span>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-semibold ${anomalyPct > 50 ? "text-red-600" : anomalyPct > 20 ? "text-yellow-600" : "text-green-600"}`}>
                          이상 {anomalyPct}%
                        </span>
                        <span className="text-xs text-zinc-400">{total}건</span>
                      </div>
                    </div>
                    {/* 스택 바 */}
                    <div className="flex h-4 overflow-hidden rounded-full bg-zinc-100">
                      {normalPct > 0 && (
                        <div className="flex items-center justify-center bg-green-400" style={{ width: `${normalPct}%` }}>
                          {normalPct >= 15 && <span className="text-[9px] font-medium text-white">{d.normal}</span>}
                        </div>
                      )}
                      {borderPct > 0 && (
                        <div className="flex items-center justify-center bg-yellow-400" style={{ width: `${borderPct}%` }}>
                          {borderPct >= 15 && <span className="text-[9px] font-medium text-white">{d.borderline}</span>}
                        </div>
                      )}
                      {warningPct > 0 && (
                        <div className="flex items-center justify-center bg-red-400" style={{ width: `${warningPct}%` }}>
                          {warningPct >= 15 && <span className="text-[9px] font-medium text-white">{d.warning}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex justify-center gap-4 text-[10px] text-zinc-400">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-400" />정상</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-yellow-400" />경계</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-red-400" />주의</span>
            </div>
          </div>
        )}

        {/* 최근 기록 */}
        <div className="rounded-xl bg-white shadow-sm">
          <h2 className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-700">최근 인지 평가 기록</h2>
          {(!cognitive || cognitive.assessments.length === 0) ? (
            <p className="px-4 py-8 text-center text-zinc-400">아직 기록이 없습니다. 대화를 통해 자동으로 수집됩니다.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {cognitive.assessments.map((a, i) => {
                const si = Math.min(2, Math.max(0, a.score));
                return (
                  <li key={`${a.domain}-${i}`} className="px-4 py-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-sm font-medium text-zinc-700">{DOMAIN_LABELS[a.domain] ?? a.domain}</span>
                        <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${si === 0 ? "bg-green-100 text-green-700" : si === 1 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>
                          {SCORE_LABELS[si]}
                        </span>
                        {a.evidence && <p className="mt-1 text-sm text-zinc-600">&ldquo;{a.evidence}&rdquo;</p>}
                        {a.note && <p className="mt-0.5 text-xs text-zinc-400">{a.note}</p>}
                      </div>
                      <span className="ml-3 shrink-0 text-xs text-zinc-400">{a.session_date}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
