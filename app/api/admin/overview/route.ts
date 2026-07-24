/**
 * GET /api/admin/overview — 관리자 대시보드 통계.
 *
 * 반환: ① 요약(역할별 회원·활성·발화량·응급) ② 회원별 사용량 표 ③ 최근 응급 이벤트.
 * 개인정보 원칙: 일상 대화 원문은 관리자에게도 비노출(동의서 §4) — 수치·메타데이터만.
 * 응급 발화 근거(emergencyEvidence)는 위급 대응 목적의 기존 노출 예외를 따른다.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET() {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "관리자 전용입니다." }, { status: 403 });

  const rl = await checkRateLimit(`admin-overview:${session.user.id}`, 30, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  try {
    const [users, links, usageRows, timeRows, emergRecent] = await Promise.all([
      prisma.user.findMany({
        select: { id: true, name: true, email: true, screeningMode: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.expertPatient.findMany({
        where: { status: "active" },
        select: { expertUserId: true, patientUserId: true },
      }),
      // 회원별 사용량 — 발화 수(전체/7일)·30일 활동일수·마지막 사용·응급(30일). 1쿼리 집계.
      prisma.$queryRawUnsafe<{
        user_id: string; total_msgs: bigint; msgs_7d: bigint; active_days_30d: bigint; emerg_30d: bigint; last_at: Date | null;
      }[]>(
        `SELECT c."userId" AS user_id,
                COUNT(*) FILTER (WHERE m.role = 'user') AS total_msgs,
                COUNT(*) FILTER (WHERE m.role = 'user' AND m."createdAt" >= NOW() - INTERVAL '7 days') AS msgs_7d,
                COUNT(DISTINCT DATE(m."createdAt" AT TIME ZONE 'Asia/Seoul'))
                  FILTER (WHERE m."createdAt" >= NOW() - INTERVAL '30 days') AS active_days_30d,
                COUNT(*) FILTER (WHERE m.role = 'user' AND m."emergencyLevel" >= 2 AND m."createdAt" >= NOW() - INTERVAL '30 days') AS emerg_30d,
                MAX(CASE WHEN m.role = 'user' THEN m."createdAt" END) AS last_at
         FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
         GROUP BY c."userId"`,
      ),
      // 사용시간 추정 — 메시지 타임스탬프 세션화(30분 이상 공백 = 새 세션, 세션당 최소 60초).
      //   별도 세션 기록 테이블 없이 산출(스키마 변경 회피). "추정"임을 화면에 명시.
      prisma.$queryRawUnsafe<{
        user_id: string; sessions: bigint; total_secs: unknown; secs_30d: unknown; secs_7d: unknown;
      }[]>(
        `WITH msgs AS (
           SELECT c."userId" AS uid, m."createdAt" AS ts
           FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
         ), marked AS (
           SELECT uid, ts,
                  CASE WHEN LAG(ts) OVER w IS NULL OR ts - LAG(ts) OVER w > INTERVAL '30 minutes' THEN 1 ELSE 0 END AS brk
           FROM msgs WINDOW w AS (PARTITION BY uid ORDER BY ts)
         ), sess AS (
           SELECT uid, ts, SUM(brk) OVER (PARTITION BY uid ORDER BY ts ROWS UNBOUNDED PRECEDING) AS sid
           FROM marked
         ), agg AS (
           SELECT uid, sid, MIN(ts) AS started,
                  GREATEST(EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts))), 60) AS secs
           FROM sess GROUP BY uid, sid
         )
         SELECT uid AS user_id, COUNT(*) AS sessions, SUM(secs) AS total_secs,
                COALESCE(SUM(secs) FILTER (WHERE started >= NOW() - INTERVAL '30 days'), 0) AS secs_30d,
                COALESCE(SUM(secs) FILTER (WHERE started >= NOW() - INTERVAL '7 days'), 0) AS secs_7d
         FROM agg GROUP BY uid`,
      ),
      prisma.message.findMany({
        where: { emergencyLevel: { gte: 2 }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          emergencyLevel: true, emergencyEvidence: true, notifiedAt: true, createdAt: true,
          conversation: { select: { user: { select: { name: true, email: true } } } },
        },
      }),
    ]);

    const usage = new Map(usageRows.map((r) => [r.user_id, r]));
    const times = new Map(timeRows.map((r) => [r.user_id, r]));
    // 이름 정리 — 과거 curl cp949 깨짐(U+FFFD) 계정은 이메일 앞부분으로 대체 표시
    const cleanName = (name: string | null, email: string | null): string => {
      const n = (name || "").trim();
      if (n && !/�/.test(n)) return n;
      return (email || "").split("@")[0] || "(이름 없음)";
    };
    const guardianCount = new Map<string, number>(); // 어르신 → 연결 보호자 수
    const patientCount = new Map<string, number>();  // 전문가 → 담당 환자 수
    for (const l of links) {
      guardianCount.set(l.patientUserId, (guardianCount.get(l.patientUserId) ?? 0) + 1);
      patientCount.set(l.expertUserId, (patientCount.get(l.expertUserId) ?? 0) + 1);
    }

    const kstDayStart = () => {
      const now = new Date(Date.now() + 9 * 3600 * 1000);
      return new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00+09:00`));
    };
    const dayStart = kstDayStart();
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const userRows = users.map((u) => {
      const s = usage.get(u.id);
      const t = times.get(u.id);
      const lastAt = s?.last_at ? new Date(s.last_at) : null;
      const secs30d = Number(t?.secs_30d ?? 0);
      const activeDays = Number(s?.active_days_30d ?? 0);
      return {
        id: u.id,
        name: cleanName(u.name, u.email),
        email: u.email ?? "",
        role: u.screeningMode ?? "user",
        createdAt: u.createdAt.toISOString(),
        guardians: guardianCount.get(u.id) ?? 0,
        patients: patientCount.get(u.id) ?? 0,
        totalMsgs: Number(s?.total_msgs ?? 0),
        msgs7d: Number(s?.msgs_7d ?? 0),
        activeDays30d: activeDays,
        emerg30d: Number(s?.emerg_30d ?? 0),
        lastAt: lastAt ? lastAt.toISOString() : null,
        sessions: Number(t?.sessions ?? 0),
        totalSecs: Number(t?.total_secs ?? 0),
        secs7d: Number(t?.secs_7d ?? 0),
        avgSecsPerActiveDay: activeDays > 0 ? Math.round(secs30d / activeDays) : 0,
      };
    });

    const byRole = { user: 0, pro: 0, general: 0 } as Record<string, number>;
    for (const u of userRows) byRole[u.role] = (byRole[u.role] ?? 0) + 1;
    const activeToday = userRows.filter((u) => u.lastAt && new Date(u.lastAt) >= dayStart).length;
    const active7d = userRows.filter((u) => u.lastAt && new Date(u.lastAt) >= weekAgo).length;
    const msgs7dTotal = userRows.reduce((s, u) => s + u.msgs7d, 0);
    const secs7dTotal = userRows.reduce((s, u) => s + u.secs7d, 0);
    const emergUnnotified = emergRecent.filter((e) => !e.notifiedAt).length;

    return NextResponse.json({
      summary: {
        totalUsers: userRows.length,
        byRole,
        activeToday,
        active7d,
        msgs7dTotal,
        secs7dTotal,
        emerg7d: emergRecent.length,
        emergUnnotified,
      },
      users: userRows,
      emergencies: emergRecent.map((e) => ({
        level: e.emergencyLevel,
        evidence: e.emergencyEvidence ?? "",
        notified: !!e.notifiedAt,
        at: e.createdAt.toISOString(),
        userName: cleanName(e.conversation.user.name, e.conversation.user.email),
      })),
    });
  } catch (e) {
    console.error("[admin-overview]", e);
    return NextResponse.json({ error: "통계 조회에 실패했습니다." }, { status: 500 });
  }
}
