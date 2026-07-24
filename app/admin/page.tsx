"use client";

/**
 * 관리자 대시보드 (/admin) — ADMIN_EMAILS에 등록된 계정 전용.
 * 회원 현황(역할·연결)·회원별 사용량(발화/활동일/마지막 사용)·최근 응급 이벤트.
 * 일상 대화 원문은 표시하지 않는다(동의서 §4 — 응급 근거만 예외).
 */
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { LogoutButton } from "../LogoutButton";

interface UserRow {
  id: string; name: string; email: string; role: string; createdAt: string;
  guardians: number; patients: number; totalMsgs: number; msgs7d: number;
  activeDays30d: number; emerg30d: number; lastAt: string | null;
  sessions: number; totalSecs: number; secs7d: number; avgSecsPerActiveDay: number;
}
interface Overview {
  summary: { totalUsers: number; byRole: Record<string, number>; activeToday: number; active7d: number; msgs7dTotal: number; secs7dTotal: number; emerg7d: number; emergUnnotified: number };
  users: UserRow[];
  emergencies: { level: number | null; evidence: string; notified: boolean; at: string; userName: string }[];
}

const ROLE_LABEL: Record<string, string> = { user: "어르신", pro: "전문가·보호자", general: "일반" };
const ROLE_STYLE: Record<string, string> = {
  user: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200",
  pro: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200",
  general: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
};

/** 사용시간 포맷 — "45분" / "3시간 25분" / "1일 4시간" */
function fmtDur(secs: number): string {
  if (!secs) return "—";
  const m = Math.round(secs / 60);
  if (m < 1) return "1분 미만";
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  const d = Math.floor(h / 24);
  return `${d}일 ${h % 24}시간`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function AdminPage() {
  const { status } = useSession();
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/admin/overview")
      .then(async (r) => {
        if (r.status === 403) throw new Error("관리자 전용 페이지입니다.");
        if (!r.ok) throw new Error("통계를 불러오지 못했습니다.");
        setData(await r.json());
      })
      .catch((e) => setError((e as Error).message));
  }, [status]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#f0f2f5] dark:bg-[#0b0d10]">
        <p className="text-lg text-zinc-600 dark:text-zinc-300">{error}</p>
        <Link href="/chat" className="text-sm text-[#007bff]">대화 화면으로</Link>
      </div>
    );
  }
  if (!data) {
    return <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5] text-zinc-500 dark:bg-[#0b0d10]">불러오는 중…</div>;
  }

  const { summary } = data;
  const cards: { label: string; value: string; warn?: boolean }[] = [
    { label: "전체 회원", value: `${summary.totalUsers}명` },
    { label: "어르신 / 전문가 / 일반", value: `${summary.byRole.user ?? 0} / ${summary.byRole.pro ?? 0} / ${summary.byRole.general ?? 0}` },
    { label: "오늘 사용 / 7일 사용", value: `${summary.activeToday}명 / ${summary.active7d}명` },
    { label: "7일 발화량", value: `${summary.msgs7dTotal}건` },
    { label: "7일 사용시간", value: fmtDur(summary.secs7dTotal) },
    { label: "응급(7일) / 미발송", value: `${summary.emerg7d}건 / ${summary.emergUnnotified}건`, warn: summary.emergUnnotified > 0 },
  ];

  return (
    <div className="min-h-screen bg-[#f0f2f5] text-zinc-900 dark:bg-[#0b0d10] dark:text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-bold">🛠 마음이음 관리자</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/chat" className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">대화 화면</Link>
          <LogoutButton className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200" />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {/* 요약 카드 */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {cards.map((c) => (
            <div key={c.label} className={`rounded-xl bg-white p-4 shadow-sm dark:bg-zinc-900 ${c.warn ? "ring-2 ring-red-500" : ""}`}>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{c.label}</p>
              <p className={`mt-1 text-xl font-bold ${c.warn ? "text-red-600" : ""}`}>{c.value}</p>
            </div>
          ))}
        </section>

        {/* 회원별 사용량 */}
        <section className="rounded-xl bg-white p-4 shadow-sm dark:bg-zinc-900">
          <h2 className="mb-3 text-base font-bold">회원별 현황 · 사용량 <span className="ml-1 text-xs font-normal text-zinc-400">(사용시간은 대화 기록 기반 추정 — 30분 이상 쉬면 별도 세션)</span></h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  <th className="py-2 pr-3">이름</th>
                  <th className="py-2 pr-3">역할</th>
                  <th className="py-2 pr-3">가입일</th>
                  <th className="py-2 pr-3">연결</th>
                  <th className="py-2 pr-3 text-right">누적 발화</th>
                  <th className="py-2 pr-3 text-right">7일 발화</th>
                  <th className="py-2 pr-3 text-right">총 사용시간</th>
                  <th className="py-2 pr-3 text-right">일평균(30일)</th>
                  <th className="py-2 pr-3 text-right">30일 활동일</th>
                  <th className="py-2 pr-3 text-right">응급(30일)</th>
                  <th className="py-2">마지막 사용</th>
                </tr>
              </thead>
              <tbody>
                {[...data.users]
                  .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))
                  .map((u) => (
                    <tr key={u.id} className="border-b border-zinc-100 dark:border-zinc-800">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{u.name}</span>
                        <span className="ml-1 text-xs text-zinc-400">{u.email}</span>
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${ROLE_STYLE[u.role] ?? ROLE_STYLE.general}`}>{ROLE_LABEL[u.role] ?? u.role}</span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-zinc-500">{u.createdAt.slice(0, 10)}</td>
                      <td className="py-2 pr-3 text-xs">
                        {u.role === "pro" ? `환자 ${u.patients}명` : u.guardians > 0 ? `보호자 ${u.guardians}명` : <span className="text-amber-600">미연결</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{u.totalMsgs.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{u.msgs7d.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtDur(u.totalSecs)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtDur(u.avgSecsPerActiveDay)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{u.activeDays30d}일</td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${u.emerg30d > 0 ? "font-bold text-red-600" : ""}`}>{u.emerg30d}</td>
                      <td className="py-2 text-xs text-zinc-500">{fmtDate(u.lastAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 최근 응급 */}
        <section className="rounded-xl bg-white p-4 shadow-sm dark:bg-zinc-900">
          <h2 className="mb-3 text-base font-bold">최근 응급 이벤트 (7일)</h2>
          {data.emergencies.length === 0 ? (
            <p className="text-sm text-zinc-500">없음</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.emergencies.map((e, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-bold text-white ${e.level === 3 ? "bg-red-600" : "bg-amber-500"}`}>L{e.level}</span>
                  <span className="font-medium">{e.userName}</span>
                  <span className="text-xs text-zinc-500">{fmtDate(e.at)}</span>
                  <span className="text-xs text-zinc-400">{e.evidence.slice(0, 60)}</span>
                  {!e.notified && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-700">미발송</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-zinc-400">※ 일상 대화 원문은 관리자에게도 표시되지 않습니다(동의 정책). 응급 근거만 예외.</p>
        </section>
      </main>
    </div>
  );
}
