"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import Link from "next/link";

interface HealthLogEntry {
  id: string;
  type: string;
  value: string | null;
  note: string | null;
  createdAt: string;
}

interface Summary {
  total: number;
  cognitiveCount: number;
  recentCognitive: number;
  byType: { type: string; count: number }[];
}

const TYPE_LABELS: Record<string, string> = {
  cognitive: "인지 오류",
  meal: "식사",
  mood: "기분",
  activity: "활동",
  etc: "기타",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function DashboardPage() {
  const { status } = useSession();
  const [logs, setLogs] = useState<HealthLogEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status !== "authenticated") return;

    (async () => {
      try {
        const res = await fetch("/api/health-logs");
        if (!res.ok) return;
        const data = (await res.json()) as { logs: HealthLogEntry[]; summary: Summary };
        setLogs(data.logs);
        setSummary(data.summary);
      } catch (e) {
        console.error("Failed to load health logs:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [status]);

  if (status === "loading" || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5]">
        <p className="text-zinc-500">로딩 중...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f0f2f5]">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-800">건강 모니터링</h1>
        <Link
          href="/chat"
          className="rounded-lg px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
        >
          대화로 돌아가기
        </Link>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* 요약 카드 */}
        {summary && (
          <div className="mb-6 grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <p className="text-sm text-zinc-500">전체 기록</p>
              <p className="text-2xl font-bold text-zinc-800">{summary.total}</p>
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <p className="text-sm text-zinc-500">인지 오류 감지</p>
              <p className="text-2xl font-bold text-orange-600">{summary.cognitiveCount}</p>
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <p className="text-sm text-zinc-500">최근 7일 인지 오류</p>
              <p className={`text-2xl font-bold ${summary.recentCognitive > 0 ? "text-red-600" : "text-green-600"}`}>
                {summary.recentCognitive}
              </p>
            </div>
          </div>
        )}

        {/* 타입별 분포 */}
        {summary && summary.byType.length > 0 && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">유형별 분포</h2>
            <div className="flex flex-wrap gap-2">
              {summary.byType.map((item) => (
                <span
                  key={item.type}
                  className={`rounded-full px-3 py-1 text-sm ${
                    item.type === "cognitive"
                      ? "bg-orange-100 text-orange-700"
                      : "bg-zinc-100 text-zinc-600"
                  }`}
                >
                  {TYPE_LABELS[item.type] ?? item.type}: {item.count}건
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 기록 목록 */}
        <div className="rounded-xl bg-white shadow-sm">
          <h2 className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-700">
            최근 기록 (최대 50건)
          </h2>
          {logs.length === 0 ? (
            <p className="px-4 py-8 text-center text-zinc-400">
              아직 기록이 없습니다. 대화를 통해 건강 데이터가 자동으로 수집됩니다.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {logs.map((log) => (
                <li key={log.id} className="px-4 py-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          log.type === "cognitive"
                            ? "bg-orange-100 text-orange-700"
                            : "bg-zinc-100 text-zinc-600"
                        }`}
                      >
                        {TYPE_LABELS[log.type] ?? log.type}
                      </span>
                      {log.value && (
                        <span className="ml-2 text-sm text-zinc-700">{log.value}</span>
                      )}
                      {log.note && (
                        <p className="mt-1 text-sm text-zinc-500">{log.note}</p>
                      )}
                    </div>
                    <span className="ml-3 shrink-0 text-xs text-zinc-400">
                      {formatDate(log.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
