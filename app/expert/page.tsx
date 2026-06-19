"use client";

/**
 * 전문가 환자 관리 — 연결된 환자 목록(등급·추세·최근 활동) + 내 초대 코드.
 * 열람 범위: 채점·요약 지표만 (대화 원문 비공개 — 프라이버시 기본값).
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";
import { LogoutButton } from "../LogoutButton";


interface PatientRow {
  id: string;
  name: string;
  age: number | null;
  gender: string | null;
  linkedAt: string;
  overallAvg: number | null;
  tier: string;
  provisional?: boolean;
  showLevel?: boolean;
  trend: string;
  trendText: string;
  anomaly7d: number;
  lastActiveAt: string | null;
  examLatest?: { band: string; label: string; score: number | null; max: number | null; sufficient: boolean; at: string } | null;
}

const BAND_STYLE: Record<string, string> = {
  "정상범위": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "경계": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "저하의심": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "자료부족": "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
};

const TIER_STYLE: Record<string, string> = {
  "정상": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "경증": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "중증": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  "고위험": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "평가전": "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};
const TREND_LABEL: Record<string, string> = {
  "급성악화": "🔴 급성악화", "악화": "🟠 악화", "안정": "🟢 안정", "개선": "🔵 개선", "자료부족": "⚪ 자료부족",
};

export default function ExpertPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [code, setCode] = useState<string>("");
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") { router.replace("/login"); return; }
    if (status !== "authenticated") return;
    (async () => {
      try {
        const [codeRes, listRes] = await Promise.all([fetch("/api/expert/code"), fetch("/api/expert/patients")]);
        if (codeRes.status === 403 || listRes.status === 403) {
          setError("전문가 계정 전용 페이지입니다. 마이페이지에서 계정 유형을 변경할 수 있어요.");
          setLoading(false);
          return;
        }
        const codeData = await codeRes.json();
        const listData = await listRes.json();
        setCode(codeData.code ?? "");
        setPatients(listData.patients ?? []);
      } catch {
        setError("정보를 불러오지 못했습니다. 새로고침해 주세요.");
      }
      setLoading(false);
    })();
  }, [status, router]);

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };

  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString("ko-KR", { month: "short", day: "numeric" }) : "—";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">🩺 환자 관리</h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/expert/protocol" className="text-sm text-teal-600 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200">검진 문항지</Link>
            <Link href="/mypage" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">마이페이지</Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {error && <p className="mb-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}

        {!error && (
          <>
            <section className="mb-8 rounded-2xl border border-teal-200 bg-teal-50 p-5 dark:border-teal-900 dark:bg-teal-900/20">
              <h2 className="mb-1 text-sm font-semibold text-teal-900 dark:text-teal-200">내 초대 코드</h2>
              <p className="mb-3 text-xs text-teal-700 dark:text-teal-300">
                환자(또는 보호자)가 마이페이지 → 전문가 연결에서 이 코드를 입력하면 목록에 추가됩니다. 연결 후에는 채점·요약 지표만 열람되며 대화 내용은 공개되지 않습니다.
              </p>
              <div className="flex items-center gap-3">
                <span className="rounded-lg bg-white px-4 py-2 font-mono text-xl font-bold tracking-widest text-teal-800 dark:bg-zinc-900 dark:text-teal-200">
                  {loading ? "……" : code || "—"}
                </span>
                <button onClick={copyCode} className="rounded-lg border border-teal-300 px-3 py-2 text-sm text-teal-800 hover:bg-teal-100 dark:border-teal-700 dark:text-teal-200 dark:hover:bg-teal-900/40">
                  {copied ? "복사됨 ✓" : "복사"}
                </button>
              </div>
            </section>

            <h2 className="mb-3 text-sm font-semibold text-zinc-600 dark:text-zinc-300">연결된 환자 {patients.length}명</h2>
            {loading && <p className="text-sm text-zinc-500">불러오는 중…</p>}
            {!loading && patients.length === 0 && (
              <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                아직 연결된 환자가 없습니다. 위 초대 코드를 환자에게 전달해 주세요.
              </p>
            )}
            <div className="grid gap-3">
              {patients.map((p) => (
                <Link key={p.id} href={`/expert/patients/${p.id}`} className="block rounded-2xl border border-zinc-200 bg-white p-4 transition hover:border-teal-400 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-teal-600">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{p.name}</span>
                      <span className="text-xs text-zinc-500">{p.age ? `${p.age}세` : ""} {p.gender === "male" ? "남" : p.gender === "female" ? "여" : ""}</span>
                      {/* 검진(1차 신호) */}
                      {p.examLatest
                        ? <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${BAND_STYLE[p.examLatest.band] ?? BAND_STYLE["자료부족"]}`}>검진 {p.examLatest.label}{p.examLatest.score != null && p.examLatest.sufficient ? ` ${p.examLatest.score}/${p.examLatest.max}` : ""}</span>
                        : <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TIER_STYLE["평가전"]}`}>검진 전</span>}
                      {/* 일상 모니터링(보조) — 평소 대화 기반. 자료 없으면 '검진'의 자료부족과 혼동되지 않게 추세칩 숨김 */}
                      <span className="text-[11px] text-zinc-400">
                        {p.showLevel === false
                          ? "일상 대화 자료 수집중"
                          : `일상 ${p.tier}${p.provisional ? "(잠정)" : ""}${p.trend && p.trend !== "자료부족" ? ` · ${TREND_LABEL[p.trend] ?? p.trend}` : ""}`}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500">
                      최근 활동 {fmtDate(p.lastActiveAt)} · 7일 이상징후 {p.anomaly7d}건{p.overallAvg !== null ? ` · 평균 ${p.overallAvg}` : ""}
                    </div>
                  </div>
                  {(p.trend === "급성악화" || p.trend === "악화") && p.trendText && (
                    <p className="mt-2 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-800 dark:bg-orange-900/30 dark:text-orange-200">{p.trendText}</p>
                  )}
                </Link>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
