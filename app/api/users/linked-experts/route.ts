/**
 * 환자 측 전문가 연결 관리 — GET: 내가 연결한 전문가 목록 / DELETE: 연결 해제(revoke).
 * 해제는 환자 본인 권리(동의 철회) — 전문가 측 목록·상세에서 즉시 사라짐(active 필터).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const links = await prisma.expertPatient.findMany({
    where: { patientUserId: session.user.id, status: "active" },
    select: { expertUserId: true, createdAt: true, expert: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    experts: links.map((l) => ({ expertUserId: l.expertUserId, name: l.expert.name ?? "전문가", linkedAt: l.createdAt })),
  });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  let expertUserId = "";
  try {
    const body = await req.json();
    expertUserId = String(body?.expertUserId ?? "");
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }
  if (!expertUserId) return NextResponse.json({ error: "expertUserId가 필요합니다." }, { status: 400 });

  const r = await prisma.expertPatient.updateMany({
    where: { expertUserId, patientUserId: session.user.id, status: "active" },
    data: { status: "revoked" },
  });
  if (r.count === 0) return NextResponse.json({ error: "연결을 찾을 수 없습니다." }, { status: 404 });

  console.log("[expert-link] revoked", JSON.stringify({ expert: expertUserId.slice(0, 8), patient: session.user.id.slice(0, 8) }));
  return NextResponse.json({ ok: true });
}
