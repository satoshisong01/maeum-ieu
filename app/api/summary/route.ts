import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeOverallAvg, classifySeverity, detectAcuteChange, RISK_DOMAIN_THRESHOLD } from "@/lib/health/severity";

const DOMAIN_LABELS: Record<string, string> = {
  orientation_time: "시간 지남력",
  orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억력",
  memory_delayed: "지연 기억력",
  language: "언어 유창성",
  judgment: "판단력",
  attention_calculation: "주의력/계산",
};

// 평가 범위 명시 — 대화(음성/텍스트) 기반이라 측정 불가한 임상 영역이 있음(과신 방지)
const NOT_ASSESSED = ["시공간 구성", "그리기(시계그리기 등)", "세밀한 실행기능"];
const COVERAGE_NOTE = "대화 기반 선별 특성상 시공간 구성·그리기·세밀한 실행기능은 평가 범위에 포함되지 않습니다.";
const DISCLAIMER = "본 결과는 대화 기반 인지 선별 보조 지표이며 의학적 진단이 아닙니다. 우려되시면 전문의 평가를 받으시길 권합니다.";

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

  // 위험 영역 (평균 임계 이상)
  const riskDomains = domainStats
    .filter((d) => d.avg_score >= RISK_DOMAIN_THRESHOLD)
    .map((d) => ({ domain: d.domain, label: DOMAIN_LABELS[d.domain] || d.domain, avgScore: d.avg_score, count: d.count }));

  // 정상 영역
  const normalDomains = domainStats
    .filter((d) => d.avg_score < RISK_DOMAIN_THRESHOLD)
    .map((d) => ({ domain: d.domain, label: DOMAIN_LABELS[d.domain] || d.domain, avgScore: d.avg_score, count: d.count }));

  // 전체 가중 평균 + 등급
  const totalAssessments = domainStats.reduce((s, d) => s + d.count, 0);
  const overallAvg = computeOverallAvg(domainStats);
  const severity = classifySeverity(overallAvg);

  // 종단 추세 — 최근 7일 vs 베이스라인(7~35일) 비교로 급성 악화 감지
  //   (장기 평균만 보면 "오래 정상 + 최근 급변"을 놓치는 문제 보완. 알림 연동은 추후.)
  let trend: { status: string; delta: number; text: string } = { status: "자료부족", delta: 0, text: "" };
  try {
    const winQuery = (clause: string) =>
      prisma.$queryRawUnsafe<AssessmentRow[]>(
        `SELECT domain, ROUND(AVG(score)::numeric, 2)::float AS avg_score, COUNT(*)::int AS count
         FROM cognitive_assessments WHERE user_id = $1 AND ${clause} GROUP BY domain`,
        userId,
      );
    const recentStats = await winQuery("session_date >= CURRENT_DATE - '7 days'::interval");
    const baseStats = await winQuery(
      "session_date < CURRENT_DATE - '7 days'::interval AND session_date >= CURRENT_DATE - '35 days'::interval",
    );
    trend = detectAcuteChange({
      recentAvg: computeOverallAvg(recentStats),
      recentCount: recentStats.reduce((s, d) => s + d.count, 0),
      baselineAvg: computeOverallAvg(baseStats),
      baselineCount: baseStats.reduce((s, d) => s + d.count, 0),
    });
  } catch { /* 테이블 없을 수 있음 */ }

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

  if (severity.text) summaryText += " " + severity.text;
  if (trend.status === "급성악화" || trend.status === "악화") summaryText += " " + trend.text;

  return NextResponse.json({
    period: periodLabel,
    days,
    activeDays,
    totalMessages,
    userMessages,
    anomalyCount,
    overallAvg: overallAvg >= 0 ? Number(overallAvg.toFixed(2)) : null,
    severityTier: severity.tier,
    trend: { status: trend.status, delta: trend.delta },
    totalAssessments,
    riskDomains,
    normalDomains,
    summaryText,
    coverage: { assessed: Object.values(DOMAIN_LABELS), notAssessed: NOT_ASSESSED, note: COVERAGE_NOTE },
    disclaimer: DISCLAIMER,
  });
}
