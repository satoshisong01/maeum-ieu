/**
 * GET  /api/medications — 현재 사용자의 복약 스케줄 목록.
 * POST /api/medications — 새 스케줄 생성. body: { label, times[], enabled? }
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeTimes } from "@/lib/chat/medication";
import { toKstDateString } from "@/lib/chat/time";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const userId = session.user.id;

  const items = await prisma.medicationSchedule.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  // 복약 준수 — 오늘 확인된 복용(스케줄|시각 키) + 최근 7일 이행률
  let todayConfirmed: string[] = [];
  let weekCompliance = { confirmed: 0, expected: 0 };
  try {
    const today = toKstDateString(new Date());
    const todayRows = await prisma.$queryRawUnsafe<{ schedule_id: string; dose_time: string }[]>(
      `SELECT schedule_id, dose_time FROM medication_log WHERE user_id = $1 AND taken_date = $2::date AND status = 'confirmed'`,
      userId, today);
    todayConfirmed = todayRows.map((r) => `${r.schedule_id}|${r.dose_time}`);
    const weekRows = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*)::int AS c FROM medication_log WHERE user_id = $1 AND status = 'confirmed' AND taken_date >= CURRENT_DATE - INTERVAL '6 days'`,
      userId);
    const dailyDoses = items.filter((i) => i.enabled).reduce((s, i) => s + (Array.isArray(i.times) ? i.times.length : 0), 0);
    weekCompliance = { confirmed: weekRows[0]?.c ?? 0, expected: dailyDoses * 7 };
  } catch { /* medication_log 미생성 환경 방어 */ }

  return NextResponse.json({ items, todayConfirmed, weekCompliance });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (!checkRateLimit(`med:${session.user.id}`, 30, 60_000).ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const { label, times, enabled } = body as { label?: string; times?: unknown; enabled?: boolean };

  if (!label || typeof label !== "string" || !label.trim()) {
    return NextResponse.json({ error: "label은 필수입니다." }, { status: 400 });
  }
  const normTimes = normalizeTimes(times);
  if (normTimes.length === 0) {
    return NextResponse.json({ error: "최소 한 개 이상의 유효 시각(HH:MM)이 필요합니다." }, { status: 400 });
  }

  const created = await prisma.medicationSchedule.create({
    data: {
      userId: session.user.id,
      label: label.trim().slice(0, 40),
      times: normTimes,
      enabled: enabled !== false,
    },
  });
  return NextResponse.json(created, { status: 201 });
}
