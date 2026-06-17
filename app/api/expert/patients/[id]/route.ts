/**
 * 전문가용 환자 상세 리포트 — GET. pro + 활성 연결 필수.
 * 열람 범위: 채점 지표 + 분석기가 작성한 임상 근거(note/evidence)까지.
 *   사용자 대화 원문(Message.content)은 조회하지 않음 — 프라이버시 기본값.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeOverallAvg, classifySeverity, detectAcuteChange, type DomainStat } from "@/lib/health/severity";
import { toKstDateString } from "@/lib/chat/time";

interface DomainRow extends DomainStat { domain: string }
interface WeekRow { week_start: string; avg_score: number; count: number }
interface EventRow { domain: string; score: number; note: string | null; evidence: string | null; session_date: string }

const DOMAIN_KO: Record<string, string> = {
  orientation_time: "시간 지남력", orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억", memory_delayed: "지연 기억",
  language: "언어", judgment: "판단력", attention_calculation: "주의·계산",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.user.screeningMode !== "pro") {
    return NextResponse.json({ error: "전문가 계정 전용 기능입니다." }, { status: 403 });
  }
  const { id: patientId } = await params;

  // 연결 관계 검증 — 미연결 환자 접근 차단
  const link = await prisma.expertPatient.findUnique({
    where: { expertUserId_patientUserId: { expertUserId: session.user.id, patientUserId: patientId } },
    select: { status: true },
  });
  if (!link || link.status !== "active") {
    return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });
  }

  const domainStats = (from: number, to: number) => prisma.$queryRawUnsafe<DomainRow[]>(
    `SELECT domain, AVG(score)::float AS avg_score, COUNT(*)::int AS count
       FROM cognitive_assessments
      WHERE user_id = $1
        AND session_date >= CURRENT_DATE - ($2::int * INTERVAL '1 day')
        AND session_date <= CURRENT_DATE - ($3::int * INTERVAL '1 day')
      GROUP BY domain`, patientId, from, to);

  const [patient, recent, baseline, weekly, events] = await Promise.all([
    prisma.user.findUnique({ where: { id: patientId }, select: { name: true, age: true, gender: true, createdAt: true } }),
    domainStats(6, 0),
    domainStats(36, 7),
    prisma.$queryRawUnsafe<WeekRow[]>(
      `SELECT to_char(date_trunc('week', session_date), 'YYYY-MM-DD') AS week_start,
              AVG(score)::float AS avg_score, COUNT(*)::int AS count
         FROM cognitive_assessments
        WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '56 day'
        GROUP BY 1 ORDER BY 1`, patientId),
    prisma.$queryRawUnsafe<EventRow[]>(
      `SELECT domain, score, note, evidence, to_char(session_date, 'YYYY-MM-DD') AS session_date
         FROM cognitive_assessments
        WHERE user_id = $1 AND score >= 1
        ORDER BY session_date DESC, created_at DESC
        LIMIT 20`, patientId),
  ]);
  if (!patient) return NextResponse.json({ error: "환자를 찾을 수 없습니다." }, { status: 404 });

  const recentAvg = computeOverallAvg(recent);
  const tier = classifySeverity(recentAvg);
  const trend = detectAcuteChange({
    recentAvg,
    recentCount: recent.reduce((s, d) => s + d.count, 0),
    baselineAvg: computeOverallAvg(baseline),
    baselineCount: baseline.reduce((s, d) => s + d.count, 0),
  });

  const baseMap = new Map(baseline.map((d) => [d.domain, d]));
  const domains = Object.keys(DOMAIN_KO).map((domain) => {
    const r = recent.find((d) => d.domain === domain);
    const b = baseMap.get(domain);
    return {
      domain, label: DOMAIN_KO[domain],
      recentAvg: r ? Number(r.avg_score.toFixed(2)) : null, recentCount: r?.count ?? 0,
      baselineAvg: b ? Number(b.avg_score.toFixed(2)) : null, baselineCount: b?.count ?? 0,
    };
  });

  // 복약 — 일정 + 오늘 복용 + 주간 이행률(보호자·전문가 열람용, 읽기전용)
  let medications: { id: string; label: string; times: string[]; enabled: boolean }[] = [];
  let medToday: string[] = [];
  let medWeek = { confirmed: 0, expected: 0 };
  try {
    const meds = await prisma.medicationSchedule.findMany({ where: { userId: patientId }, orderBy: { createdAt: "asc" } });
    medications = meds.map((m) => ({ id: m.id, label: m.label, times: Array.isArray(m.times) ? (m.times as string[]) : [], enabled: m.enabled }));
    const today = toKstDateString(new Date());
    const tRows = await prisma.$queryRawUnsafe<{ schedule_id: string; dose_time: string }[]>(
      `SELECT schedule_id, dose_time FROM medication_log WHERE user_id = $1 AND taken_date = $2::date AND status = 'confirmed'`, patientId, today);
    medToday = tRows.map((r) => `${r.schedule_id}|${r.dose_time}`);
    const wRows = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*)::int AS c FROM medication_log WHERE user_id = $1 AND status = 'confirmed' AND taken_date >= CURRENT_DATE - INTERVAL '6 days'`, patientId);
    const dailyDoses = medications.filter((m) => m.enabled).reduce((s, m) => s + m.times.length, 0);
    medWeek = { confirmed: wRows[0]?.c ?? 0, expected: dailyDoses * 7 };
  } catch { /* medication_log 미생성 환경 방어 */ }

  // 감사 로그 — 환자 상세 열람 기록 (규제 대비, 실패 무시)
  prisma.$executeRawUnsafe(
    `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, $3, 'detail')`,
    `eal_${Date.now()}_${session.user.id.slice(0, 8)}`, session.user.id, patientId,
  ).catch(() => {});
  return NextResponse.json({
    patient: { name: patient.name ?? "이름 미설정", age: patient.age, gender: patient.gender, joinedAt: patient.createdAt },
    overallAvg: recentAvg < 0 ? null : Number(recentAvg.toFixed(2)),
    tier: tier.tier, tierText: tier.text,
    trend: trend.status, trendText: trend.text, trendDelta: trend.delta,
    domains,
    weekly: weekly.map((w) => ({ weekStart: w.week_start, avg: Number(w.avg_score.toFixed(2)), count: w.count })),
    events: events.map((e) => ({ date: e.session_date, domain: DOMAIN_KO[e.domain] ?? e.domain, score: e.score, note: e.note, evidence: e.evidence })),
    medication: { items: medications, todayConfirmed: medToday, weekCompliance: medWeek },
  });
}
