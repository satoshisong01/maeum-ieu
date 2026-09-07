"use client";

/**
 * 검진 결과지 — 인쇄/PDF용 한 장 리포트. 전문가 상세와 동일 API(pro+활성연결) 사용.
 * 대화 원문은 싣지 않음(프라이버시). 로드 후 자동 인쇄 다이얼로그.
 */
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface ExamSession {
  id: string; startedAt: string; endedAt: string | null; doctorComment: string;
  totalScore: number | null; maxScore: number | null;
  coverage: { answered: number; total: number; sufficient: boolean };
  evalLabel: string | null; evalAdvice: string | null;
  formalLabel: string | null; formalScore: number | null; formalMax: number | null;
  educationYears: number | null; visuospatialScore: number | null;
  items: { itemId: string; domain: string; prompt: string; answer: string; score: number; max: number; reason: string }[];
  trend: null | { direction: string; deltaPct: number };
}
interface Detail {
  viewerRole?: "pro" | "guardian";
  patient: { name: string; age: number | null; gender: string | null };
  examDisclaimer?: string;
  examSessions?: ExamSession[];
  examTrend?: { direction: string; label: string; detail: string } | null;
  examTrendPoints?: { round: number; date: string; score: number; max: number; band: string | null }[];
}

const fmt = (iso: string) => new Date(iso).toLocaleString("ko-KR");

export default function ExamReportPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!params?.id) return;
    fetch(`/api/expert/patients/${params.id}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) { setError(d.error ?? "불러오지 못했습니다."); return; }
        setData(d);
      })
      .catch(() => setError("불러오지 못했습니다."));
  }, [params]);

  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-sm text-zinc-500">결과지를 준비 중…</div>;
  if (data.viewerRole === "guardian") {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="text-lg font-bold text-zinc-800 dark:text-zinc-100">🩺 검진 결과지는 담당 의사 전용입니다</p>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">문항별 채점·평가 기준 등 상세 검진 내역은 담당 의사만 볼 수 있어요. 보호자에게는 상태 요약과 위급 알림만 제공됩니다.</p>
        <a href={`/expert/patients/${params?.id}`} className="mt-5 inline-block rounded-full bg-zinc-800 px-6 py-3 text-sm font-semibold text-white dark:bg-zinc-200 dark:text-zinc-900">← 상태 요약으로</a>
      </div>
    );
  }

  const sessions = data.examSessions ?? [];
  const latest = sessions.find((e) => e.totalScore != null) ?? sessions[0];
  const g = data.patient.gender === "male" ? "남" : data.patient.gender === "female" ? "여" : "-";

  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-zinc-900 print:p-0">
      <style>{`@media print { @page { margin: 14mm; } .no-print { display:none } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`}</style>

      <div className="no-print mb-4 flex justify-end">
        <button onClick={() => window.print()} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white">🖨 인쇄 / PDF 저장</button>
      </div>

      <header className="mb-5 border-b-2 border-zinc-800 pb-3">
        <h1 className="text-xl font-bold">마음이음 인지선별 검진 결과지</h1>
        <p className="mt-1 text-sm text-zinc-600">발행일 {new Date().toLocaleDateString("ko-KR")}</p>
      </header>

      <section className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <div><span className="text-zinc-500">성명</span> <b>{data.patient.name}</b></div>
        <div><span className="text-zinc-500">나이/성별</span> {data.patient.age ?? "-"}세 / {g}</div>
        <div><span className="text-zinc-500">검진 횟수</span> {sessions.length}회</div>
        <div><span className="text-zinc-500">최근 검진</span> {latest ? fmt(latest.startedAt) : "-"}</div>
      </section>

      {latest && (
        <section className="mb-4 rounded border border-zinc-300 p-3">
          <h2 className="mb-1 text-sm font-bold">최근 검진 평가</h2>
          <p className="text-sm">
            {latest.coverage.sufficient && latest.totalScore != null
              ? <>음성 선별 <b>{latest.totalScore}/{latest.maxScore}점</b> · <b>{latest.formalLabel ?? latest.evalLabel}</b></>
              : <><b>자료부족</b> — 무응답이 많아 평가 불가(응답 {latest.coverage.answered}/{latest.coverage.total}영역)</>}
          </p>
          {latest.evalAdvice && <p className="mt-1 text-xs text-zinc-600">{latest.evalAdvice}</p>}
          {data.examTrend && data.examTrend.direction !== "부족" && (
            <p className="mt-1 text-xs text-zinc-700">추세: <b>{data.examTrend.label}</b> — {data.examTrend.detail}</p>
          )}
        </section>
      )}

      {sessions.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-1 text-sm font-bold">회차별 점수</h2>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-300 text-left text-zinc-500">
                <th className="py-1">회차</th><th>검진일</th><th>점수</th><th>평가</th><th>응답영역</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((e, i) => (
                <tr key={e.id} className="border-b border-zinc-100">
                  <td className="py-1">{sessions.length - i}회</td>
                  <td>{e.startedAt.slice(0, 10)}</td>
                  <td>{e.totalScore != null && e.coverage.sufficient ? `${e.totalScore}/${e.maxScore}` : "-"}</td>
                  <td>{e.formalLabel ?? e.evalLabel ?? "-"}</td>
                  <td>{e.coverage.answered}/{e.coverage.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {latest && latest.items.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-1 text-sm font-bold">최근 회차 항목별 채점</h2>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-300 text-left text-zinc-500"><th className="py-1">문항</th><th>응답 요지</th><th>점수</th></tr>
            </thead>
            <tbody>
              {latest.items.map((it) => (
                <tr key={it.itemId} className="border-b border-zinc-100 align-top">
                  <td className="py-1 pr-2">{it.prompt}</td>
                  <td className="pr-2 text-zinc-600">{it.reason || it.answer}</td>
                  <td className="whitespace-nowrap">{it.score}/{it.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {latest?.doctorComment && (
        <section className="mb-4">
          <h2 className="mb-1 text-sm font-bold">의사 소견</h2>
          <p className="whitespace-pre-wrap rounded border border-zinc-300 p-2 text-xs">{latest.doctorComment}</p>
        </section>
      )}

      <footer className="mt-6 border-t border-zinc-300 pt-2 text-[10px] leading-relaxed text-zinc-500">
        {data.examDisclaimer}
      </footer>
    </div>
  );
}
