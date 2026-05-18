/**
 * GET /api/medications/check — 지금 due한 슬롯 목록 반환.
 * 클라이언트가 주기적으로(1분 간격) 폴링하여 due 발견 시 /trigger 호출.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findDueSlot } from "@/lib/chat/medication";

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
