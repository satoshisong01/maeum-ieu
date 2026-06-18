/**
 * 전문가 검진 세션 — start(시작 기록) / end(종료 시각) / comment(의사 코멘트=환자 일지).
 * 보안: pro 계정 + ExpertPatient active 연결만. 세션 수정은 그 세션의 expert 본인만.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.user.screeningMode !== "pro") return NextResponse.json({ error: "전문가 전용 기능입니다." }, { status: 403 });
  const expertId = session.user.id;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "start") {
    const patientId = typeof body.patientId === "string" ? body.patientId : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    const link = await prisma.expertPatient.findUnique({
      where: { expertUserId_patientUserId: { expertUserId: expertId, patientUserId: patientId } },
      select: { status: true },
    });
    if (!link || link.status !== "active") return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO exam_session (id, patient_user_id, expert_user_id, conversation_id) VALUES ($1, $2, $3, $4)`,
      id, patientId, expertId, conversationId,
    );
    return NextResponse.json({ sessionId: id });
  }

  if (action === "end" || action === "comment") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    // 본인 세션만 수정
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM exam_session WHERE id = $1 AND expert_user_id = $2`, sessionId, expertId);
    if (rows.length === 0) return NextResponse.json({ error: "세션을 찾을 수 없습니다." }, { status: 404 });
    if (action === "end") {
      await prisma.$executeRawUnsafe(`UPDATE exam_session SET ended_at = now() WHERE id = $1`, sessionId);
    } else {
      const comment = typeof body.comment === "string" ? body.comment.slice(0, 4000) : "";
      await prisma.$executeRawUnsafe(`UPDATE exam_session SET doctor_comment = $2 WHERE id = $1`, sessionId, comment);
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
}
