import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface CognitiveRow {
  domain: string;
  score: number;
  confidence: number;
  evidence: string | null;
  note: string | null;
  session_date: string;
  created_at: Date;
}

interface DomainAvg { domain: string; avg_score: number; count: number; }
interface DailyTrend { session_date: string; avg_score: number; check_count: number; normal: number; borderline: number; warning: number; }

interface EmergencyRow {
  id: string;
  content: string;
  emergencyLevel: number | null;
  emergencyEvidence: string | null;
  speakerLabel: string | null;
  createdAt: Date;
}
interface EmergencyDaily { day: string; l1: number; l2: number; l3: number; }

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const userId = session.user.id;

  // Message 테이블에서 isAnomaly 건수
  const anomalyCount = await prisma.message.count({
    where: { conversation: { userId }, isAnomaly: true },
  });

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentAnomaly = await prisma.message.count({
    where: { conversation: { userId }, isAnomaly: true, createdAt: { gte: sevenDaysAgo } },
  });

  // cognitive_assessments 데이터
  let assessments: CognitiveRow[] = [];
  let domainAverages: DomainAvg[] = [];
  let dailyTrend: DailyTrend[] = [];

  try {
    assessments = await prisma.$queryRawUnsafe<CognitiveRow[]>(
      `SELECT domain, score, confidence, evidence, note, session_date::text, created_at
       FROM cognitive_assessments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, userId,
    );
    domainAverages = await prisma.$queryRawUnsafe<DomainAvg[]>(
      `SELECT domain, ROUND(AVG(score)::numeric, 2)::float AS avg_score, COUNT(*)::int AS count
       FROM cognitive_assessments WHERE user_id = $1 GROUP BY domain ORDER BY avg_score DESC`, userId,
    );
    dailyTrend = await prisma.$queryRawUnsafe<DailyTrend[]>(
      `SELECT session_date::text,
              ROUND(AVG(score)::numeric, 2)::float AS avg_score,
              COUNT(*)::int AS check_count,
              COUNT(*) FILTER (WHERE score < 1)::int AS normal,
              COUNT(*) FILTER (WHERE score >= 1 AND score < 2)::int AS borderline,
              COUNT(*) FILTER (WHERE score >= 2)::int AS warning
       FROM cognitive_assessments WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '14 days'
       GROUP BY session_date ORDER BY session_date ASC`, userId,
    );
  } catch { /* cognitive_assessments 테이블 없을 수 있음 */ }

  // 응급 신호 (최근 50건 + 일별 카운트)
  const recentEmergencies: EmergencyRow[] = await prisma.message.findMany({
    where: {
      conversation: { userId },
      emergencyLevel: { gte: 1 },
    },
    select: { id: true, content: true, emergencyLevel: true, emergencyEvidence: true, speakerLabel: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  let emergencyDaily: EmergencyDaily[] = [];
  try {
    emergencyDaily = await prisma.$queryRawUnsafe<EmergencyDaily[]>(
      `SELECT to_char(m."createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE m."emergencyLevel" = 1)::int AS l1,
              COUNT(*) FILTER (WHERE m."emergencyLevel" = 2)::int AS l2,
              COUNT(*) FILTER (WHERE m."emergencyLevel" = 3)::int AS l3
       FROM "Message" m
       JOIN "Conversation" c ON m."conversationId" = c.id
       WHERE c."userId" = $1
         AND m."emergencyLevel" IS NOT NULL AND m."emergencyLevel" >= 1
         AND m."createdAt" >= NOW() - INTERVAL '14 days'
       GROUP BY day ORDER BY day ASC`,
      userId,
    );
  } catch { /* 컬럼 없을 수 있음 */ }

  const emergencySummary = {
    totalL3: recentEmergencies.filter((e) => e.emergencyLevel === 3).length,
    totalL2: recentEmergencies.filter((e) => e.emergencyLevel === 2).length,
    totalL1: recentEmergencies.filter((e) => e.emergencyLevel === 1).length,
    last24hCount: recentEmergencies.filter((e) => {
      const ms24 = 24 * 60 * 60 * 1000;
      return Date.now() - new Date(e.createdAt).getTime() <= ms24;
    }).length,
  };

  return NextResponse.json({
    summary: { anomalyCount, recentAnomaly },
    cognitive: { assessments, domainAverages, dailyTrend },
    emergency: {
      summary: emergencySummary,
      recent: recentEmergencies,
      daily: emergencyDaily,
    },
  });
}
