import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const DOMAIN_LABELS: Record<string, string> = {
  orientation_time: "시간 지남력",
  orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억력",
  memory_delayed: "지연 기억력",
  language: "언어 유창성",
  judgment: "판단력",
  attention_calculation: "주의력/계산",
};

interface AssessmentRow {
  domain: string;
  avg_score: number;
  count: number;
}

/** GET /api/summary?period=week|month */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const userId = session.user.id;
  const { searchParams } = new URL(req.url);
  const period = searchParams.get("period") || "week";
  const days = period === "month" ? 30 : 7;

  const conv = await prisma.conversation.findUnique({ where: { userId } });
  if (!conv) {
    return NextResponse.json({ error: "대화 기록이 없습니다." }, { status: 404 });
  }

  const since = new Date();
  since.setDate(since.getDate() - days);

  // 기간 내 메시지 통계
  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id, createdAt: { gte: since } },
    select: { role: true, isAnomaly: true, createdAt: true },
  });

  const totalMessages = messages.length;
  const userMessages = messages.filter((m) => m.role === "user").length;
  const anomalyCount = messages.filter((m) => m.isAnomaly).length;

  // 대화 일수 계산
  const uniqueDays = new Set(
    messages.map((m) => m.createdAt.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })),
  );
  const activeDays = uniqueDays.size;

  // 기간 내 인지 평가 영역별 통계
  let domainStats: AssessmentRow[] = [];
  try {
    domainStats = await prisma.$queryRawUnsafe<AssessmentRow[]>(
      `SELECT domain, ROUND(AVG(score)::numeric, 2)::float AS avg_score, COUNT(*)::int AS count
       FROM cognitive_assessments WHERE user_id = $1 AND session_date >= CURRENT_DATE - ($2 || ' days')::interval
       GROUP BY domain ORDER BY avg_score DESC`,
      userId,
      String(days),
    );
  } catch { /* 테이블 없을 수 있음 */ }

  // 위험 영역 (평균 1.0 이상)
  const riskDomains = domainStats
    .filter((d) => d.avg_score >= 1.0)
    .map((d) => ({ domain: d.domain, label: DOMAIN_LABELS[d.domain] || d.domain, avgScore: d.avg_score, count: d.count }));

  // 정상 영역
  const normalDomains = domainStats
    .filter((d) => d.avg_score < 1.0)
    .map((d) => ({ domain: d.domain, label: DOMAIN_LABELS[d.domain] || d.domain, avgScore: d.avg_score, count: d.count }));

  // 전체 평균
  const totalAssessments = domainStats.reduce((s, d) => s + d.count, 0);
  const overallAvg = totalAssessments > 0
    ? domainStats.reduce((s, d) => s + d.avg_score * d.count, 0) / totalAssessments
    : -1;

  // 요약 텍스트 생성
  const periodLabel = period === "month" ? "최근 30일" : "최근 7일";
  let summaryText = `${periodLabel} 동안 ${activeDays}일간 대화하였으며, 총 ${userMessages}건의 발화가 있었습니다.`;

  if (anomalyCount > 0) {
    summaryText += ` 이 중 ${anomalyCount}건에서 인지 이상 징후가 감지되었습니다.`;
  } else {
    summaryText += ` 인지 이상 징후는 감지되지 않았습니다.`;
  }

  if (riskDomains.length > 0) {
    summaryText += ` 주의가 필요한 영역: ${riskDomains.map((d) => d.label).join(", ")}.`;
  }

  if (overallAvg >= 0) {
    if (overallAvg < 0.3) summaryText += " 전반적으로 정상 범위입니다.";
    else if (overallAvg < 0.8) summaryText += " 경미한 인지 변화가 관찰되므로 지속적인 모니터링을 권장합니다.";
    else if (overallAvg < 1.5) summaryText += " 인지 저하 가능성이 있으므로 전문의 상담을 권장합니다.";
    else summaryText += " 심각한 인지 저하가 의심되므로 즉시 전문의 상담이 필요합니다.";
  }

  return NextResponse.json({
    period: periodLabel,
    days,
    activeDays,
    totalMessages,
    userMessages,
    anomalyCount,
    overallAvg: overallAvg >= 0 ? Number(overallAvg.toFixed(2)) : null,
    totalAssessments,
    riskDomains,
    normalDomains,
    summaryText,
  });
}
