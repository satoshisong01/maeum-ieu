/**
 * Live 음성 턴 저장 — 클라가 Gemini Live에 직결해 나눈 한 턴(사용자 전사 + AI 전사)을
 * 서버에 회송: Message 저장 + 인지 분석(사용자/전문가만) 연결.
 * Live 경로 v1 제약: 검진(mental flow)·응급 즉답 게이트는 클라 측 안전망과 별개로 미지원 —
 * 응급 어휘 감지 시 isEmergency 플래그를 반환해 클라가 안내 모드로 전환하게 한다.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveMessages } from "@/lib/chat/messages";
import { runCognitiveAnalysis } from "@/lib/chat/cognitive-run";
import { buildHistoryText } from "@/lib/chat/history-text";
import { getTimeContext } from "@/lib/chat/time";
import { detectEmergency } from "@/lib/chat/emergency";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;

  const rl = checkRateLimit(`live-turn:${userId}`, 60, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const userText = String(body?.userText || "").slice(0, 2000).trim();
  const aiText = String(body?.aiText || "").slice(0, 4000).trim();
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId.slice(0, 100) : undefined;
  if (!userText || !aiText || !conversationId) {
    return NextResponse.json({ error: "userText/aiText/conversationId 필수" }, { status: 400 });
  }
  try {
    // 대화 소유권 검증 — 타인 대화에 끼워넣기 차단
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { userId: true } });
    if (!conv || conv.userId !== userId) return NextResponse.json({ error: "대화를 찾을 수 없습니다." }, { status: 404 });

    const { userMsgId } = await saveMessages({ conversationId, userId, userContent: userText, assistantContent: aiText });

    // 인지 분석 — 일반인(general)은 목적 분리 원칙대로 미실행
    const mode = session.user.screeningMode === "pro" ? "pro" : session.user.screeningMode === "general" ? "general" : "user";
    if (mode !== "general" && userMsgId) {
      const rows = await prisma.message.findMany({
        where: { conversationId }, orderBy: { createdAt: "desc" }, take: 20,
        select: { role: true, content: true, createdAt: true },
      });
      const historyText = buildHistoryText(rows.reverse().map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })));
      const t = getTimeContext();
      const envBlock = `[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]\n- 현재 한국 시각: ${t.dateStr}\n- 시간대: ${t.timeLabel}`;
      runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: userText, assistantResponse: aiText, historyText, envBlock })
        .catch((e) => console.error("[live-turn:cognitive]", e));
    }

    // 응급 어휘 감지 — Live 경로는 서버 즉답 게이트가 없으므로 클라에 신호만 전달
    const emergency = detectEmergency(userText);
    return NextResponse.json({ ok: true, emergencyLevel: emergency.level });
  } catch (e) {
    console.error("[live-turn]", e);
    return NextResponse.json({ error: "저장 중 오류가 발생했습니다." }, { status: 500 });
  }
}
