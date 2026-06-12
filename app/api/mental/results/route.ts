/**
 * T3 검진 결과 — GET. 본인만 열람(세션 사용자 기준 — 전문가·보호자 비공개가 T3 기본값).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SCALES } from "@/lib/screening/mental-bank";

interface SessionRow { id: string; scale: string; total: number; severity: string; crisis: boolean; created_at: string }

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
    `SELECT id, scale, total, severity, crisis, to_char(created_at, 'YYYY-MM-DD') AS created_at
       FROM mental_session
      WHERE user_id = $1 AND status = 'done'
      ORDER BY created_at DESC LIMIT 24`, session.user.id);

  // 프로파일형 척도(BFI-10)는 문항별 점수로 해석 — 해당 세션만 일괄 조회
  const profileSessionIds = rows.filter((r) => SCALES[r.scale]?.interpretItems).map((r) => r.id);
  const itemScores = new Map<string, { itemNo: number; score: number }[]>();
  if (profileSessionIds.length > 0) {
    const assess = await prisma.$queryRawUnsafe<{ session_id: string; item_no: number; score: number }[]>(
      `SELECT session_id, item_no, score FROM mental_assessments WHERE session_id = ANY($1)`,
      profileSessionIds);
    for (const a of assess) {
      const list = itemScores.get(a.session_id) ?? [];
      list.push({ itemNo: a.item_no, score: a.score });
      itemScores.set(a.session_id, list);
    }
  }

  const results = rows.map((r) => {
    const sc = SCALES[r.scale] ?? SCALES.PHQ9;
    const interp = sc.interpretItems
      ? sc.interpretItems(itemScores.get(r.id) ?? [])
      : sc.interpret(r.total);
    return {
      id: r.id, scale: r.scale, scaleName: sc.name, maxTotal: sc.maxTotal, date: r.created_at,
      total: r.total, severity: r.severity, crisis: r.crisis, text: interp.text, recommend: interp.recommend,
      profile: !!sc.interpretItems,
    };
  });
  return NextResponse.json({ results });
}
