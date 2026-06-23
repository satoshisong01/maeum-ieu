/**
 * PATCH /api/messages/speaker — 메시지 화자 라벨 변경.
 * body: { messageId: string; label: "primary" | "visitor" | "unknown" | null }
 * 보호자 권한 검증: 메시지가 현재 로그인 사용자 본인 또는 본인 보호 대상의 대화에 속해야 함.
 *
 * Phase 1에서는 본인 메시지만 (대화 owner = 로그인 사용자) 허용.
 * Phase 2에서 보호자 권한 모델 도입 후 확장.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidSpeakerLabel } from "@/lib/chat/speaker";
import { checkRateLimit } from "@/lib/rate-limit";

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (!(await checkRateLimit(`speaker:${session.user.id}`, 60, 60_000)).ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const { messageId, label } = body as { messageId?: string; label?: string | null };

  if (!messageId || typeof messageId !== "string") {
    return NextResponse.json({ error: "messageId가 필요합니다." }, { status: 400 });
  }
  if (label !== null && !isValidSpeakerLabel(label)) {
    return NextResponse.json({ error: "label은 primary/visitor/unknown 또는 null이어야 합니다." }, { status: 400 });
  }

  // 메시지 소유권 확인
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, role: true, conversation: { select: { userId: true } } },
  });
  if (!msg) return NextResponse.json({ error: "메시지를 찾을 수 없습니다." }, { status: 404 });
  if (msg.conversation.userId !== session.user.id) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }
  // assistant 메시지에는 라벨 의미 없음 (AI 발화는 화자 X)
  if (msg.role !== "user") {
    return NextResponse.json({ error: "사용자 메시지에만 라벨링 가능합니다." }, { status: 400 });
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { speakerLabel: label === null ? null : label },
    select: { id: true, speakerLabel: true },
  });

  return NextResponse.json(updated);
}
