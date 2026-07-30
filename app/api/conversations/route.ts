import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Session } from "next-auth";

/**
 * 대화 소유자 결정 — 기본은 본인. 전문가 대리 검사 시 proxyPatientId(연결된 환자)로 귀속.
 * 반환 null = 권한 없음(pro 아님 또는 미연결). pro + active 연결만 허용.
 */
async function resolveOwnerId(session: Session, proxyPatientId: string | null): Promise<string | null> {
  const me = session.user!.id;
  if (!proxyPatientId || proxyPatientId === me) return me;
  if (session.user!.screeningMode !== "pro") return null;
  const link = await prisma.expertPatient.findUnique({
    where: { expertUserId_patientUserId: { expertUserId: me, patientUserId: proxyPatientId } },
    select: { status: true },
  });
  return link && link.status === "active" ? proxyPatientId : null;
}

/** GET: 대상 사용자(본인 또는 대리 환자)의 대화 1개 + 전체 메시지 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const proxyPatientId = new URL(req.url).searchParams.get("patient");
  const ownerId = await resolveOwnerId(session, proxyPatientId);
  if (!ownerId) return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });
  // 대리(검진) 접근은 대화 "원문"을 반환하지 않는다(2026-07-07 감사 blocker).
  //   동의서 §4: 일상 대화 원문은 보호자·전문가에게 비공개 — 검진 플로우는 conversation.id만 필요.
  const isProxyAccess = ownerId !== session.user.id;

  const conv = await prisma.conversation.findUnique({
    where: { userId: ownerId },
    include: {
      messages: isProxyAccess
        ? { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, role: true, content: true, createdAt: true } } // lastMessageAt 계산용 1건만(내용 미반환)
        : { orderBy: { createdAt: "asc" }, select: { id: true, role: true, content: true, createdAt: true } },
    },
  });

  if (!conv) return NextResponse.json({ conversation: null, messages: [], lastMessageAt: null });

  const lastMsg = conv.messages.length > 0
    ? (isProxyAccess ? conv.messages[0] : conv.messages[conv.messages.length - 1])
    : null;

  return NextResponse.json({
    conversation: { id: conv.id },
    messages: isProxyAccess ? [] : conv.messages.filter((m) => !m.content.startsWith("[관찰]")).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
    lastMessageAt: lastMsg?.createdAt?.toISOString() ?? null,
  });
}

/** POST: 대상 사용자당 대화 1개 보장(get-or-create). 대리 검사 시 환자 계정에 생성. */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const proxyPatientId = typeof body?.proxyPatientId === "string" ? body.proxyPatientId : null;
  const ownerId = await resolveOwnerId(session, proxyPatientId);
  if (!ownerId) return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });

  const conv = await prisma.conversation.upsert({
    where: { userId: ownerId },
    create: { userId: ownerId },
    update: {},
  });
  return NextResponse.json({ id: conv.id });
}
