/**
 * POST /api/medications/trigger — 특정 스케줄의 알림을 실제로 발화 + 메시지 저장.
 * body: { scheduleId, conversationId }
 *
 * 동작:
 * 1) 스케줄 권한·due 재검증 (중복 발송 방지)
 * 2) AI 멘트 빌드 + 대화에 assistant 메시지로 저장
 * 3) lastTriggeredAt 갱신
 * 4) 응답: { text, slotTime }
 *
 * 동시성: 같은 슬롯에 폴링이 여러 번 들어와도 findDueSlot이 lastTriggeredAt 확인하므로 dedup.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findDueSlot, buildMedicationReminder } from "@/lib/chat/medication";
import { saveGreetingMessage } from "@/lib/chat/messages";
import { getHonorific } from "@/lib/chat/prompt";
import { COMPANION_DEFAULTS } from "@/lib/chat/constants";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { scheduleId, conversationId } = body as { scheduleId?: string; conversationId?: string };
  if (!scheduleId) return NextResponse.json({ error: "scheduleId가 필요합니다." }, { status: 400 });

  const schedule = await prisma.medicationSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) return NextResponse.json({ error: "스케줄을 찾을 수 없습니다." }, { status: 404 });
  if (schedule.userId !== session.user.id) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  // 다시 due 검증 (중복 방지)
  const due = findDueSlot(schedule);
  if (!due) {
    return NextResponse.json({ skipped: true, reason: "not due or already triggered" });
  }

  // 슬롯 선점(원자적 CAS) — 동시 폴링/재시도가 같은 슬롯을 중복 발화하지 않도록,
  // 우리가 읽은 lastTriggeredAt 값일 때만 갱신. 패배하면 메시지 저장 없이 skip.
  const claim = await prisma.medicationSchedule.updateMany({
    where: { id: scheduleId, lastTriggeredAt: schedule.lastTriggeredAt ?? null },
    data: { lastTriggeredAt: new Date() },
  });
  if (claim.count === 0) {
    return NextResponse.json({ skipped: true, reason: "already triggered (race)" });
  }

  // 사용자 호칭/동반자 조회
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { age: true, gender: true, userHonorific: true, companionName: true },
  });
  const honorific = user?.userHonorific?.trim() || getHonorific(user?.age ?? null, user?.gender ?? null);
  const companionName = user?.companionName?.trim() || COMPANION_DEFAULTS.name;

  const text = buildMedicationReminder(due.label, due.slotTime, honorific, companionName);

  // assistant 메시지로 저장 (대화 ID 있을 때만)
  if (conversationId) {
    // 대화 소유권 검증
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { userId: true } });
    if (conv && conv.userId === session.user.id) {
      await saveGreetingMessage(conversationId, text);
    }
  }

  // (트리거 시각은 위 CAS에서 이미 마킹됨)
  return NextResponse.json({ text, slotTime: due.slotTime, label: due.label });
}
