/**
 * 상시 감시(관찰자 모드) — 환자 발화 조각 1개 처리.
 *
 * 클라가 온디바이스에서 (1) 발화 단위로 분할, (2) 화자식별로 "등록된 환자 목소리"만 통과시켜
 * 그 조각의 WAV(base64)를 여기로 보낸다. 다른 사람/잡음은 클라에서 폐기 → 서버 미도달(제3자 녹음 회피).
 *
 * 서버: 전사 → 응급 감지(정규식+LLM 백스톱) → L2+면 보호자 알림 → 관찰 로그로 저장.
 * 1차: 응급만 활성. (인지/급성변화 분석은 저장된 전사로 후속 확장 — runCognitiveAnalysis 훅 자리 표시)
 *
 * 개인정보: 환자 본인 발화만 처리(동의 대상). 원음성은 저장하지 않고 전사 텍스트만 보존.
 */
import { NextResponse, after } from "next/server";
import type { Part } from "@google/genai";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGenAI, extractText, COMPANION_SAFETY_SETTINGS, logUsage } from "@/lib/chat/llm";
import { evaluateSttConfidence } from "@/lib/chat/stt-confidence";
import { detectEmergency } from "@/lib/chat/emergency";
import { detectEmergencyLLM } from "@/lib/chat/emergency-llm";
import { notifyGuardian } from "@/lib/chat/emergency-notify";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_AUDIO_B64 = 3_000_000; // ~2MB WAV (30초 16k mono ≈ 960KB) 상한

async function transcribe(audioB64: string, mimeType: string): Promise<string> {
  const parts: Part[] = [
    { text: "이 음성을 한국어로 정확하게 받아쓰기하세요. 받아쓰기한 텍스트만 출력하세요. 침묵이거나 잡음뿐이면 아무것도 출력하지 마세요. 들리지 않은 말을 지어내지 마세요." },
    { inlineData: { mimeType, data: audioB64 } },
  ];
  const res = await getGenAI().models.generateContent({
    model: process.env.STT_MODEL || "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
    config: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 64 }, safetySettings: COMPANION_SAFETY_SETTINGS },
  });
  logUsage("observe-stt", res);
  return extractText(res, { isUserSpeech: true }).trim();
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;

  // 상시 감시는 조각이 잦으므로 넉넉히(분당 120) — 남용은 차단
  const rl = await checkRateLimit(`observe:${userId}`, 120, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const audioB64 = typeof body?.audio === "string" ? body.audio : "";
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "audio/wav";
  if (!audioB64 || audioB64.length > MAX_AUDIO_B64) {
    return NextResponse.json({ error: "오디오 형식 오류" }, { status: 400 });
  }
  // 감시 대상 = 본인 계정(어르신). 대리(보호자가 환자 계정 감시)는 후속 — 1차는 본인 세션.
  if (session.user.screeningMode === "general") {
    return NextResponse.json({ error: "이 계정은 감시 대상이 아닙니다." }, { status: 400 });
  }

  try {
    const text = await transcribe(audioB64, mimeType);
    const conf = evaluateSttConfidence(text);
    if (!text || !conf.pass) {
      return NextResponse.json({ ok: true, skipped: true, reason: conf.reason || "empty" });
    }

    // 응급 감지 — 정규식 우선, none이면 LLM 백스톱
    let emergency = detectEmergency(text);
    if (emergency.level === 0) {
      const llm = await detectEmergencyLLM(text);
      if (llm) emergency = llm;
    }

    // 관찰 로그 저장 — 감시 전용이라 AI 응답 없음. user 메시지 1건만 직접 생성(빈 assistant 미생성).
    //   "[관찰]" 접두로 일반 대화와 구분. 응급 dedup·알림마킹(notifyGuardian)이 Message 행에 의존하므로 여기 저장.
    let conv = await prisma.conversation.findUnique({ where: { userId }, select: { id: true } });
    if (!conv) conv = await prisma.conversation.create({ data: { userId }, select: { id: true } });
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id, role: "user", content: `[관찰] ${text}`,
        emergencyLevel: emergency.level > 0 ? emergency.level : null,
        emergencyEvidence: emergency.level > 0 ? `${emergency.category}:${emergency.evidence}` : null,
      },
      select: { id: true },
    });
    const userMsgId = msg.id;

    // 보호자 알림(L2+) — 메인 경로와 동등한 안전망
    if (emergency.level >= 2 && userMsgId) {
      const level = emergency.level as 2 | 3;
      const send = async () => {
        try {
          await notifyGuardian({
            userId, userName: session.user.name || "사용자", messageId: userMsgId, level,
            category: emergency.category, content: text, aiReply: "", createdAt: new Date(),
          });
        } catch (e) { console.error("[observe-notify]", e); }
      };
      try { after(send); } catch { await send(); }
    }

    return NextResponse.json({ ok: true, text, emergencyLevel: emergency.level });
  } catch (e) {
    console.error("[observe-turn]", e);
    return NextResponse.json({ error: "처리 중 오류" }, { status: 500 });
  }
}
