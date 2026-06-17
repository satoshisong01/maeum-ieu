/**
 * GET /api/medications/check — 지금 due한 슬롯 목록 반환.
 * 클라이언트가 주기적으로(1분 간격) 폴링하여 due 발견 시 /trigger 호출.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { randomUUID } from "crypto";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findDueSlot } from "@/lib/chat/medication";
import { toKstDateString } from "@/lib/chat/time";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const schedules = await prisma.medicationSchedule.findMany({
    where: { userId: session.user.id, enabled: true },
  });

  const now = new Date();
  const due = schedules
    .map((s) => findDueSlot(s, now))
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return NextResponse.json({ due, checkedAt: now.toISOString() });
}

/**
 * POST /api/medications/check — 복용 확인/건너뜀 기록.
 * body: { scheduleId, doseTime: "HH:MM", status?: "confirmed"|"skipped" }
 * 멱등 — 같은 (사용자·스케줄·오늘·시각)은 상태만 갱신. 본인 스케줄만 허용.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  const { scheduleId, doseTime, status } = body as { scheduleId?: string; doseTime?: string; status?: string };
  if (!scheduleId || typeof scheduleId !== "string" || !doseTime || !/^\d{2}:\d{2}$/.test(doseTime)) {
    return NextResponse.json({ error: "scheduleId와 doseTime(HH:MM)이 필요합니다." }, { status: 400 });
  }
  const st = status === "skipped" ? "skipped" : "confirmed";

  // 소유권 검증 — 본인 스케줄만
  const owned = await prisma.medicationSchedule.findFirst({ where: { id: scheduleId, userId }, select: { id: true } });
  if (!owned) return NextResponse.json({ error: "잘못된 복약 일정입니다." }, { status: 403 });

  const today = toKstDateString(new Date());
  await prisma.$executeRawUnsafe(
    `INSERT INTO medication_log (id, user_id, schedule_id, dose_time, taken_date, status)
     VALUES ($1, $2, $3, $4, $5::date, $6)
     ON CONFLICT (user_id, schedule_id, taken_date, dose_time)
     DO UPDATE SET status = EXCLUDED.status, created_at = now()`,
    randomUUID(), userId, scheduleId, doseTime, today, st);

  return NextResponse.json({ ok: true, status: st });
}
