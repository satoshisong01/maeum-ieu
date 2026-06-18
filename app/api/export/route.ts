import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const DOMAIN_LABELS: Record<string, string> = {
  orientation_time: "시간 지남력",
  orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억력",
  memory_delayed: "지연 기억력",
  language: "언어 유창성",
  judgment: "판단력",
  attention_calculation: "주의력/계산",
};

/** CSV 셀 — 수식 인젝션(=,+,-,@,탭,CR로 시작) 무력화 + 따옴표 이스케이프(Excel 보호). */
function csvCell(v: string | null | undefined): string {
  let s = (v ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** GET /api/export?type=chat|assessment */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  // 어르신(user) 본인은 자기 인지결과·분석노트 비공개(A안) — 결과는 보호자·전문가만 열람.
  if (session.user.screeningMode === "user") {
    return NextResponse.json({ error: "본인은 열람할 수 없습니다." }, { status: 403 });
  }

  const userId = session.user.id;
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "chat";

  if (type === "chat") {
    return exportChat(userId);
  }
  return exportAssessments(userId);
}

/** 대화 기록 CSV */
async function exportChat(userId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { userId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { role: true, content: true, isAnomaly: true, analysisNote: true, createdAt: true },
      },
    },
  });

  if (!conv || conv.messages.length === 0) {
    return new NextResponse("데이터가 없습니다.", { status: 404 });
  }

  const BOM = "\uFEFF";
  const header = "날짜,시간,역할,내용,이상징후,분석노트";
  const rows = conv.messages.map((m) => {
    const dt = new Date(m.createdAt);
    const date = dt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
    const time = dt.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
    const role = m.role === "user" ? "사용자" : "AI";
    const anomaly = m.isAnomaly ? "O" : "";
    return `${date},${time},${role},${csvCell(m.content)},${anomaly},${csvCell(m.analysisNote)}`;
  });

  const csv = BOM + header + "\n" + rows.join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="maeum-ieu-chat-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

/** 인지 평가 기록 CSV */
async function exportAssessments(userId: string) {
  const rows = await prisma.$queryRawUnsafe<{
    domain: string; score: number; confidence: number;
    evidence: string | null; note: string | null; session_date: string; created_at: Date;
  }[]>(
    `SELECT domain, score, confidence, evidence, note, session_date::text, created_at
     FROM cognitive_assessments WHERE user_id = $1 ORDER BY created_at DESC`,
    userId,
  );

  if (!rows || rows.length === 0) {
    return new NextResponse("데이터가 없습니다.", { status: 404 });
  }

  const BOM = "\uFEFF";
  const header = "날짜,영역,영역명,점수,신뢰도,근거,분석노트";
  const csvRows = rows.map((r) => {
    const domainLabel = DOMAIN_LABELS[r.domain] || r.domain;
    return `${r.session_date},${r.domain},${domainLabel},${r.score},${r.confidence},${csvCell(r.evidence)},${csvCell(r.note)}`;
  });

  const csv = BOM + header + "\n" + csvRows.join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="maeum-ieu-assessment-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
