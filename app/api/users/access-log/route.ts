/**
 * 내 데이터 열람 내역 — GET. 본인(환자) 전용 프라이버시 투명성.
 * 연결된 전문가가 내 리포트를 언제 봤는지 expert_access_log를 본인 시점으로 공개.
 * 'list'(목록 조회)는 patient_user_id='*'로 기록되므로 나와 연결된 전문가의 것만 포함.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface LogRow { action: string; created_at: string; expert_name: string | null }

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const rows = await prisma.$queryRawUnsafe<LogRow[]>(
    `SELECT e.action, to_char(e.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS created_at,
            u.name AS expert_name
       FROM expert_access_log e
       JOIN "User" u ON u.id = e.expert_user_id
      WHERE e.patient_user_id = $1
         OR (e.patient_user_id = '*' AND e.expert_user_id IN (
              SELECT "expertUserId" FROM "ExpertPatient"
               WHERE "patientUserId" = $1 AND status = 'active'))
      ORDER BY e.created_at DESC
      LIMIT 20`, session.user.id);

  return NextResponse.json({
    logs: rows.map((r) => ({
      expertName: r.expert_name ?? "이름 미설정",
      action: r.action === "detail" ? "상세 리포트 열람" : "환자 목록 조회",
      at: r.created_at,
    })),
  });
}
