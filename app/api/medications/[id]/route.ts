/**
 * PUT    /api/medications/[id] — 스케줄 수정. body: { label?, times?, enabled? }
 * DELETE /api/medications/[id] — 스케줄 삭제.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeTimes } from "@/lib/chat/medication";

async function authorize(id: string, userId: string) {
  const item = await prisma.medicationSchedule.findUnique({ where: { id }, select: { userId: true } });
  if (!item) return { ok: false, status: 404, error: "스케줄을 찾을 수 없습니다." };
  if (item.userId !== userId) return { ok: false, status: 403, error: "권한이 없습니다." };
  return { ok: true };
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { id } = await ctx.params;
  const auth = await authorize(id, session.user.id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const { label, times, enabled } = body as { label?: string; times?: unknown; enabled?: boolean };

  const updateData: { label?: string; times?: string[]; enabled?: boolean } = {};
  if (typeof label === "string" && label.trim()) updateData.label = label.trim().slice(0, 40);
  if (times !== undefined) {
    const normTimes = normalizeTimes(times);
    if (normTimes.length === 0) {
      return NextResponse.json({ error: "최소 한 개 이상의 유효 시각이 필요합니다." }, { status: 400 });
    }
    updateData.times = normTimes;
  }
  if (typeof enabled === "boolean") updateData.enabled = enabled;

  const updated = await prisma.medicationSchedule.update({
    where: { id },
    data: updateData,
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { id } = await ctx.params;
  const auth = await authorize(id, session.user.id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  await prisma.medicationSchedule.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
