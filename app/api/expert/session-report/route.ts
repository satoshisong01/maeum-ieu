/**
 * 전문가 검사 결과지 — GET ?date=YYYY-MM-DD (기본 오늘, KST).
 * pro 계정이 자기 기기에서 시행한 표준검사(해당 계정의 cognitive_assessments)를
 * 영역별 결과지로 정리: 점수·근거·종합 소견. 시행일 목록도 함께 반환.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface Row { domain: string; score: number; evidence: string | null; note: string | null; created_at: string }
interface DayRow { d: string; n: number }

const DOMAIN_KO: Record<string, string> = {
  orientation_time: "시간 지남력", orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억", memory_delayed: "지연 기억",
  language: "언어", judgment: "판단력", attention_calculation: "주의·계산",
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.user.screeningMode !== "pro") {
    return NextResponse.json({ error: "전문가 계정 전용 기능입니다." }, { status: 403 });
  }
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam || "") ? dateParam : null;

  const [days, rows] = await Promise.all([
    prisma.$queryRawUnsafe<DayRow[]>(
      `SELECT to_char(session_date, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
         FROM cognitive_assessments WHERE user_id = $1
        GROUP BY session_date ORDER BY session_date DESC LIMIT 14`, session.user.id),
    prisma.$queryRawUnsafe<Row[]>(
      `SELECT domain, score, evidence, note, to_char(created_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS created_at
         FROM cognitive_assessments
        WHERE user_id = $1 AND session_date = COALESCE($2::date, (now() AT TIME ZONE 'Asia/Seoul')::date)
        ORDER BY created_at ASC`, session.user.id, date),
  ]);

  // 영역별 정리 — 해당 영역의 최고(=최악) 점수와 근거 목록
  const byDomain = new Map<string, { worst: number; items: { score: number; evidence: string | null; note: string | null; at: string }[] }>();
  for (const r of rows) {
    const cur = byDomain.get(r.domain) ?? { worst: 0, items: [] };
    cur.worst = Math.max(cur.worst, r.score);
    cur.items.push({ score: r.score, evidence: r.evidence, note: r.note, at: r.created_at });
    byDomain.set(r.domain, cur);
  }
  const domains = Object.keys(DOMAIN_KO).map((domain) => {
    const d = byDomain.get(domain);
    return {
      domain, label: DOMAIN_KO[domain],
      assessed: !!d, worst: d?.worst ?? null,
      items: d?.items ?? [],
    };
  });

  const assessedCount = domains.filter((d) => d.assessed).length;
  const flagged = domains.filter((d) => (d.worst ?? 0) >= 1);
  const summary = assessedCount === 0
    ? "해당 일자에 시행된 검사가 없습니다."
    : flagged.length === 0
      ? `${assessedCount}/7개 영역 시행 — 전 영역 정상 범위.`
      : `${assessedCount}/7개 영역 시행 — 주의 영역 ${flagged.length}건: ${flagged.map((d) => `${d.label}(${d.worst}점)`).join(", ")}. 임상 평가 시 해당 영역을 우선 확인하세요.`;

  return NextResponse.json({ days, domains, summary, assessedCount });
}
