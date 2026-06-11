/**
 * T3 검진 결과 — GET. 본인만 열람(세션 사용자 기준 — 전문가·보호자 비공개가 T3 기본값).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { interpretPHQ9 } from "@/lib/screening/mental-bank";

interface SessionRow { id: string; scale: string; total: number; severity: string; created_at: string }

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
    `SELECT id, scale, total, severity, to_char(created_at, 'YYYY-MM-DD') AS created_at
       FROM mental_session
      WHERE user_id = $1 AND status = 'done'
      ORDER BY created_at DESC LIMIT 24`, session.user.id);

  const results = rows.map((r) => {
    const interp = interpretPHQ9(r.total);
    return { id: r.id, scale: r.scale, date: r.created_at, total: r.total, severity: r.severity, text: interp.text, recommend: interp.recommend };
  });
  return NextResponse.json({ results });
}
