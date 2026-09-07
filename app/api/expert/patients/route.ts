/**
 * 전문가의 연결 환자 목록 — GET. pro 계정 전용.
 * 열람 범위: 채점·요약 지표만 (등급/추세/위험영역/최근 활동) — 대화 원문 비공개(프라이버시 기본값).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fetchDomainStats } from "@/lib/health/cognitive-alert";
import { computeOverallAvg, classifySeverity, detectAcuteChange, assessReliability, guardianStatusLine } from "@/lib/health/severity";
import { classifyProvisional } from "@/lib/screening/exam-eval";
import { resolveViewerRole } from "@/lib/roles";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  // 의사(pro)=상세 지표, 보호자(guardian)=요약만. 그 외 계정은 차단.
  const role = resolveViewerRole(session.user.screeningMode);
  if (!role) return NextResponse.json({ error: "의사·보호자 계정 전용 기능입니다." }, { status: 403 });
  const isDoctor = role === "pro";

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
    const [recent, baseline, lastMsg, anomaly7d, examRows] = await Promise.all([
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
      prisma.$queryRawUnsafe<{ total_score: number | null; max_score: number | null; coverage_status: string | null; started_at: Date }[]>(
        `SELECT total_score, max_score, coverage_status, started_at FROM exam_session WHERE patient_user_id = $1 AND expert_user_id = $2 AND ended_at IS NOT NULL AND total_score IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
        p.id, session.user.id).catch(() => []),
    ]);
    // 최신 검진(1차 신호) — 잠정 등급 + 점수. 자료부족이면 점수 비노출.
    const ex = examRows[0];
    const examLatest = ex
      ? (() => { const r = classifyProvisional(ex.total_score ?? 0, ex.max_score ?? undefined, ex.coverage_status !== "insufficient"); return { band: r.band, label: r.label, score: ex.total_score, max: ex.max_score, sufficient: ex.coverage_status !== "insufficient", at: ex.started_at }; })()
      : null;
    const recentAvg = computeOverallAvg(recent);
    const tier = classifySeverity(recentAvg);
    const reliability = assessReliability(recent.reduce((s, d) => s + d.count, 0), recent.filter((d) => d.count >= 2).length);
    const trend = detectAcuteChange({
      recentAvg,
      recentCount: recent.reduce((s, d) => s + d.count, 0),
      baselineAvg: computeOverallAvg(baseline),
      baselineCount: baseline.reduce((s, d) => s + d.count, 0),
    });
    // 표시 등급 — 표본 부족이면 '평가전'으로 낮춰 과대판정 방지
    const shownTier = reliability.showLevel ? tier.tier : "평가전";

    // 보호자(guardian): 상세 점수·이상징후 건수·검진 점수 비공개. 등급→평이한 문구 + 진료 권고만.
    if (!isDoctor) {
      const status = guardianStatusLine(shownTier);
      const needsCare = status.needsCare || trend.status === "급성악화" || trend.status === "악화" || examLatest?.band === "저하의심";
      return {
        id: p.id,
        name: p.name ?? "이름 미설정",
        age: p.age,
        gender: p.gender,
        linkedAt: link.createdAt,
        tier: shownTier,
        statusLine: status.headline,
        needsCare,
        examBand: examLatest?.band ?? null,   // 라벨만(점수 비공개)
        lastActiveAt: lastMsg?.createdAt ?? null,
      };
    }

    // 의사(pro): 채점·요약 지표 전체
    return {
      id: p.id,
      name: p.name ?? "이름 미설정",
      age: p.age,
      gender: p.gender,
      linkedAt: link.createdAt,
      overallAvg: recentAvg < 0 ? null : Number(recentAvg.toFixed(2)),
      tier: tier.tier,
      provisional: reliability.provisional,
      showLevel: reliability.showLevel,
      trend: trend.status,
      trendText: trend.text,
      anomaly7d,
      lastActiveAt: lastMsg?.createdAt ?? null,
      examLatest,
    };
  }));

  // 감사 로그 — 전문가의 환자 데이터 열람 기록 (규제 대비, 실패 무시)
  prisma.$executeRawUnsafe(
    `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, '*', 'list')`,
    `eal_${Date.now()}_${session.user.id.slice(0, 8)}`, session.user.id,
  ).catch(() => {});

  return NextResponse.json({ patients, viewerRole: role });
}
