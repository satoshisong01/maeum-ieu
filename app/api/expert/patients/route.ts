/**
 * 전문가의 연결 환자 목록 — GET. pro 계정 전용.
 * 열람 범위: 채점·요약 지표만 (등급/추세/위험영역/최근 활동) — 대화 원문 비공개(프라이버시 기본값).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fetchDomainStats } from "@/lib/health/cognitive-alert";
import { computeOverallAvg, classifySeverity, detectAcuteChange } from "@/lib/health/severity";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.user.screeningMode !== "pro") {
    return NextResponse.json({ error: "전문가 계정 전용 기능입니다." }, { status: 403 });
  }

  const links = await prisma.expertPatient.findMany({
    where: { expertUserId: session.user.id, status: "active" },
    select: {
      createdAt: true,
      patient: { select: { id: true, name: true, age: true, gender: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const patients = await Promise.all(links.map(async (link) => {
    const p = link.patient;
    const [recent, baseline, lastMsg, anomaly7d] = await Promise.all([
      fetchDomainStats(p.id, 6, 0),
      fetchDomainStats(p.id, 36, 7),
      prisma.message.findFirst({
        where: { conversation: { userId: p.id }, role: "user" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.message.count({
        where: { conversation: { userId: p.id }, isAnomaly: true, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      }),
    ]);
    const recentAvg = computeOverallAvg(recent);
    const tier = classifySeverity(recentAvg);
    const trend = detectAcuteChange({
      recentAvg,
      recentCount: recent.reduce((s, d) => s + d.count, 0),
      baselineAvg: computeOverallAvg(baseline),
      baselineCount: baseline.reduce((s, d) => s + d.count, 0),
    });
    return {
      id: p.id,
      name: p.name ?? "이름 미설정",
      age: p.age,
      gender: p.gender,
      linkedAt: link.createdAt,
      overallAvg: recentAvg < 0 ? null : Number(recentAvg.toFixed(2)),
      tier: tier.tier,
      trend: trend.status,
      trendText: trend.text,
      anomaly7d,
      lastActiveAt: lastMsg?.createdAt ?? null,
    };
  }));

  // 감사 로그 — 전문가의 환자 데이터 열람 기록 (규제 대비, 실패 무시)
  prisma.$executeRawUnsafe(
    `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, '*', 'list')`,
    `eal_${Date.now()}_${session.user.id.slice(0, 8)}`, session.user.id,
  ).catch(() => {});

  return NextResponse.json({ patients });
}
