import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const userId = session.user.id;

  const [logs, stats] = await Promise.all([
    prisma.healthLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        value: true,
        note: true,
        createdAt: true,
      },
    }),
    prisma.healthLog.groupBy({
      by: ["type"],
      where: { userId },
      _count: { id: true },
    }),
  ]);

  const total = stats.reduce((sum, s) => sum + s._count.id, 0);
  const cognitiveCount = stats.find((s) => s.type === "cognitive")?._count.id ?? 0;

  // 최근 7일간 인지 오류 수
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const recentCognitive = await prisma.healthLog.count({
    where: {
      userId,
      type: "cognitive",
      createdAt: { gte: sevenDaysAgo },
    },
  });

  return NextResponse.json({
    logs,
    summary: {
      total,
      cognitiveCount,
      recentCognitive,
      byType: stats.map((s) => ({ type: s.type, count: s._count.id })),
    },
  });
}
