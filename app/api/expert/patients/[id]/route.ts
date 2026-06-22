/**
 * 전문가용 환자 상세 리포트 — GET. pro + 활성 연결 필수.
 * 열람 범위: 채점 지표 + 분석기가 작성한 임상 근거(note/evidence)까지.
 *   사용자 대화 원문(Message.content)은 조회하지 않음 — 프라이버시 기본값.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeOverallAvg, classifySeverity, detectAcuteChange, assessReliability, type DomainStat } from "@/lib/health/severity";
import { classifyProvisional, classifyFormal, compareSessions, summarizeExamTrend, EXAM_DISCLAIMER, type ExamTrend } from "@/lib/screening/exam-eval";
import { itemLabel } from "@/lib/screening/cist-bank";
import { toKstDateString } from "@/lib/chat/time";

interface DomainRow extends DomainStat { domain: string }
interface WeekRow { week_start: string; avg_score: number; count: number }
interface EventRow { domain: string; score: number; note: string | null; evidence: string | null; session_date: string }

const DOMAIN_KO: Record<string, string> = {
  orientation_time: "시간 지남력", orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억", memory_delayed: "지연 기억",
  language: "언어", judgment: "판단력", attention_calculation: "주의·계산",
};

// 응급 카테고리 → 보호자용 한글 라벨 (lib/chat/emergency.ts EmergencyCategory와 일치)
const EMERGENCY_KO: Record<string, string> = {
  medical_acute: "급성 의학적 위급(호흡·가슴·의식)",
  fall_injury: "낙상·부상",
  medication_error: "약물 오남용",
  suicidal: "자해·자살 위험",
  bleeding: "출혈",
  severe_pain: "심한 통증",
  dizziness_help: "어지럼·도움 요청",
  weakness_trend: "누적 무기력",
  appetite_loss: "식욕 저하",
  sleep_distress: "수면 곤란",
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
  // 표본 신뢰도 — 소표본(예: 7턴)에 '중증' 단정 방지. 충분/잠정/판정보류 구분.
  const reliability = assessReliability(recent.reduce((s, d) => s + d.count, 0), recent.filter((d) => d.count >= 2).length);
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

  // MMSE-K 환산 추정(참고용) — 음성 시행 7영역의 정성 점수(0정상~2저하)를 영역 가중치로 환산.
  //   시공간(구성)은 음성 미시행이라 만점에서 제외. 정식 검사 점수가 아닌 추정치.
  const CIST_WEIGHT: Record<string, number> = {
    orientation_time: 5, orientation_place: 5, memory_immediate: 3,
    attention_calculation: 5, memory_delayed: 3, language: 5, judgment: 3,
  };
  let cistEarned = 0, cistMax = 0;
  for (const d of domains) {
    const w = CIST_WEIGHT[d.domain] ?? 0;
    if (d.recentAvg === null || w === 0) continue;
    cistMax += w;
    cistEarned += w * (1 - Math.min(2, Math.max(0, d.recentAvg)) / 2);
  }
  const cistEstimate = cistMax > 0 ? { earned: Math.round(cistEarned), max: cistMax, assessedDomains: domains.filter((d) => d.recentAvg !== null && CIST_WEIGHT[d.domain]).length } : null;

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

  // 회차별 분석 — 검사일(session_date)별로 묶어 회차로 비교(주기적 검사: 월 1회 등)
  const sessionRows = await prisma.$queryRawUnsafe<{ date: string; domain: string; avg: number; cnt: number }[]>(
    `SELECT to_char(session_date,'YYYY-MM-DD') AS date, domain, AVG(score)::float AS avg, COUNT(*)::int AS cnt
       FROM cognitive_assessments WHERE user_id = $1
       GROUP BY session_date, domain ORDER BY session_date DESC`, patientId);
  const byDate = new Map<string, DomainRow[]>();
  for (const r of sessionRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push({ domain: r.domain, avg_score: r.avg, count: r.cnt });
  }
  const sessions = [...byDate.entries()].slice(0, 12).map(([date, stats]) => {
    const avg = computeOverallAvg(stats);
    return {
      date,
      overallAvg: avg < 0 ? null : Number(avg.toFixed(2)),
      tier: classifySeverity(avg).tier,
      count: stats.reduce((s, d) => s + d.count, 0),
      domains: stats.map((d) => ({ label: DOMAIN_KO[d.domain] ?? d.domain, avg: Number(d.avg_score.toFixed(2)) })),
    };
  });

  // 검진 세션 — 문답(Q&A) + 의사 코멘트 + 평가(잠정/학력보정) + 회차 추세. 문답 원문은 검진 구간 메시지만 노출(일상대화와 분리).
  interface ExamSessionView {
    id: string; startedAt: string; endedAt: string | null; doctorComment: string;
    totalScore: number | null; maxScore: number | null;
    coverage: { answered: number; total: number; sufficient: boolean };
    evalBand: string | null; evalLabel: string | null; evalAdvice: string | null;
    educationYears: number | null; visuospatialScore: number | null;
    formalBand: string | null; formalLabel: string | null; formalAdvice: string | null; formalScore: number | null; formalMax: number | null;
    items: { itemId: string; label: string; domain: string; prompt: string; answer: string; score: number; max: number; reason: string }[];
    qa: { role: string; content: string; at: string }[];
    trend: null | { direction: string; deltaPct: number };
  }
  let examSessions: ExamSessionView[] = [];
  let examTrend: ExamTrend | null = null;
  let examTrendPoints: { round: number; date: string; score: number; max: number; band: string | null }[] = [];
  try {
    const rows = await prisma.$queryRawUnsafe<{ id: string; started_at: Date; ended_at: Date | null; doctor_comment: string | null; total_score: number | null; max_score: number | null; eval_band: string | null; coverage_status: string | null; answered_domains: number | null; total_domains: number | null; education_years: number | null; visuospatial_score: number | null }[]>(
      `SELECT id, started_at, ended_at, doctor_comment, total_score, max_score, eval_band, coverage_status, answered_domains, total_domains, education_years, visuospatial_score FROM exam_session WHERE patient_user_id = $1 AND expert_user_id = $2 ORDER BY started_at DESC LIMIT 10`,
      patientId, session.user.id);
    const built = await Promise.all(rows.map(async (r) => {
      const start = new Date(r.started_at);
      const end = r.ended_at ? new Date(r.ended_at) : new Date(start.getTime() + 25 * 60 * 1000);
      const [msgs, itemRows] = await Promise.all([
        prisma.message.findMany({
          where: { conversation: { userId: patientId }, createdAt: { gte: start, lte: end } },
          orderBy: { createdAt: "asc" }, select: { role: true, content: true, createdAt: true },
        }),
        prisma.$queryRawUnsafe<{ item_id: string; domain: string; prompt: string | null; answer: string | null; score: number; max_points: number; reason: string | null }[]>(
          `SELECT item_id, domain, prompt, answer, score, max_points, reason FROM exam_item_score WHERE session_id = $1 ORDER BY created_at`, r.id),
      ]);
      const sufficient = r.coverage_status !== "insufficient";
      const provisional = r.total_score != null ? classifyProvisional(r.total_score, r.max_score ?? undefined, sufficient) : null;
      // 의사가 학력·시공간을 입력했으면 학력보정 잠정 등급 계산
      const formal = (r.total_score != null && (r.education_years != null || r.visuospatial_score != null))
        ? classifyFormal({ voiceScore: r.total_score, visuospatial: r.visuospatial_score, educationYears: r.education_years, sufficient })
        : null;
      return {
        id: r.id,
        startedAt: start.toISOString(),
        endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        doctorComment: r.doctor_comment ?? "",
        totalScore: r.total_score, maxScore: r.max_score,
        coverage: { answered: r.answered_domains ?? 0, total: r.total_domains ?? 0, sufficient },
        evalBand: provisional?.band ?? null, evalLabel: provisional?.label ?? null, evalAdvice: provisional?.advice ?? null,
        educationYears: r.education_years, visuospatialScore: r.visuospatial_score,
        formalBand: formal?.band ?? null, formalLabel: formal?.label ?? null, formalAdvice: formal?.advice ?? null, formalScore: formal?.fullScore ?? null, formalMax: formal?.fullMax ?? null,
        // 배점 0점 보조 문항(예: 숫자 거꾸로)은 총점 미반영 → 항목별 채점/결과지에서 제외(질문·답변은 문답 기록에 남음)
        items: itemRows.filter((it) => it.max_points > 0).map((it) => ({ itemId: it.item_id, label: itemLabel(it.item_id), domain: it.domain, prompt: it.prompt ?? "", answer: it.answer ?? "", score: it.score, max: it.max_points, reason: it.reason ?? "" })),
        qa: msgs.map((m) => ({ role: m.role, content: m.content, at: m.createdAt.toISOString() })),
        trend: null as null | { direction: string; deltaPct: number },
      };
    }));
    // 회차 추세 — 각 회차를 바로 이전(더 오래된) 회차와 비교(DESC 정렬이므로 i+1이 이전 회차)
    for (let i = 0; i < built.length - 1; i++) {
      const cur = built[i], prev = built[i + 1];
      if (cur.totalScore != null && cur.maxScore && prev.totalScore != null && prev.maxScore && cur.coverage.sufficient && prev.coverage.sufficient) {
        cur.trend = compareSessions(prev.totalScore, prev.maxScore, cur.totalScore, cur.maxScore);
      }
    }
    examSessions = built;
    // 회차 추세 — 평가가능(자료충분·점수있음) 회차를 시간순(오래된→최신)으로 분석
    const chrono = [...built].reverse().filter((e) => e.totalScore != null && e.maxScore && e.coverage.sufficient);
    examTrendPoints = chrono.map((e, i) => ({ round: i + 1, date: e.startedAt.slice(0, 10), score: e.totalScore as number, max: e.maxScore as number, band: e.evalBand }));
    examTrend = summarizeExamTrend(chrono.map((e) => ({ score: e.totalScore as number, max: e.maxScore as number })));
  } catch { /* exam_session 미생성 환경 방어 */ }

  // 위급 알림 이력 — 응급(L2/L3) 감지 이벤트 + 보호자 알림 발송 여부(notifiedAt)
  const emergencyRows = await prisma.message.findMany({
    where: { conversation: { userId: patientId }, emergencyLevel: { gte: 2 } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { emergencyLevel: true, emergencyEvidence: true, notifiedAt: true, createdAt: true },
  });
  const emergencies = emergencyRows.map((e) => {
    const key = (e.emergencyEvidence ?? "").split(":")[0];
    return {
      level: e.emergencyLevel ?? 0,
      category: EMERGENCY_KO[key] ?? "기타 위급",
      at: e.createdAt.toISOString(),
      notified: e.notifiedAt != null,
    };
  });

  // 감사 로그 — 환자 상세 열람 기록 (규제 대비, 실패 무시)
  prisma.$executeRawUnsafe(
    `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, $3, 'detail')`,
    `eal_${Date.now()}_${session.user.id.slice(0, 8)}`, session.user.id, patientId,
  ).catch(() => {});
  return NextResponse.json({
    patient: { name: patient.name ?? "이름 미설정", age: patient.age, gender: patient.gender, joinedAt: patient.createdAt },
    overallAvg: recentAvg < 0 ? null : Number(recentAvg.toFixed(2)),
    tier: tier.tier, tierText: tier.text, reliability,
    trend: trend.status, trendText: trend.text, trendDelta: trend.delta,
    domains,
    weekly: weekly.map((w) => ({ weekStart: w.week_start, avg: Number(w.avg_score.toFixed(2)), count: w.count })),
    events: events.map((e) => ({ date: e.session_date, domain: DOMAIN_KO[e.domain] ?? e.domain, score: e.score, note: e.note, evidence: e.evidence })),
    emergencies,
    medication: { items: medications, todayConfirmed: medToday, weekCompliance: medWeek },
    sessions,
    cistEstimate,
    examSessions,
    examTrend,
    examTrendPoints,
    examDisclaimer: EXAM_DISCLAIMER,
  });
}
