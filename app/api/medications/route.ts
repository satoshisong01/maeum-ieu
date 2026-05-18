/**
 * GET  /api/medications — 현재 사용자의 복약 스케줄 목록.
 * POST /api/medications — 새 스케줄 생성. body: { label, times[], enabled? }
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeTimes } from "@/lib/chat/medication";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const items = await prisma.medicationSchedule.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

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
