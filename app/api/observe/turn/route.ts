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
import { detectWithBackstop, applyL1Escalation } from "@/lib/chat/emergency-evaluate";
import { notifyGuardian } from "@/lib/chat/emergency-notify";
import { lastResortEmergency } from "@/lib/chat/emergency-last-resort";
import { checkRateLimit } from "@/lib/rate-limit";
import { toObservationContent } from "@/lib/chat/observation";

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

  // 전사는 try 밖에서 받아 catch가 쓸 수 있게 한다 — 안쪽에서만 알면 DB 실패 시 발화를 잃는다.
  let observed = "";
  try {
    const text = await transcribe(audioB64, mimeType);
    observed = text;
    if (!text) return NextResponse.json({ ok: true, skipped: true, reason: "empty" });

    // 응급 감지 — 정규식 우선, none이면 LLM 백스톱(DB 미사용). **STT 신뢰도 게이트보다 먼저** 한다.
    const emergency = await detectWithBackstop(text);

    /**
     * STT 저신뢰 게이트는 **응급이 아닐 때만** — /api/chat과 같은 처방(2026-10-02 수정분).
     *
     * 결함(2026-10-06 적대 감사 → 재현): 이 경로에선 게이트가 응급 판정 **앞**에 있었다.
     *   보속증(같은 말 되풀이)은 치매의 전형 증상인데, evaluateSttConfidence는 그걸
     *   `vocabulary collapse`로 떨어뜨린다. 실측: "죽고 싶어 죽고 싶어 죽고 싶어 죽고 싶어"
     *   → stt.pass=false **이면서** detectEmergency L3 suicidal. 저장도 알림도 없이 버려졌다.
     *   한 번만 말했으면 잡혔을 발화가, 더 절박하게 반복할수록 더 확실히 버려지는 역전이다.
     *   상시 감시 대상은 혼자 있는 중증 어르신이라 대신 알아챌 사람도 없다.
     *   stt-confidence.ts 헤더의 불변식("응급 감지는 STT 신뢰도와 무관하게 먼저")과도 반대였다.
     */
    const conf = evaluateSttConfidence(text);
    if (!conf.pass && emergency.level === 0) {
      return NextResponse.json({ ok: true, skipped: true, reason: conf.reason || "low-confidence" });
    }
    if (!conf.pass) {
      console.log("[observe-turn] STT 저신뢰이나 응급 동반 — 게이트 우회:", conf.reason, "L" + emergency.level);
    }

    // 관찰 로그 저장 — 감시 전용이라 AI 응답 없음. user 메시지 1건만 직접 생성(빈 assistant 미생성).
    //   "[관찰]" 접두로 일반 대화와 구분. 응급 dedup·알림마킹(notifyGuardian)이 Message 행에 의존하므로 여기 저장.
    let conv = await prisma.conversation.findUnique({ where: { userId }, select: { id: true } });
    if (!conv) conv = await prisma.conversation.create({ data: { userId }, select: { id: true } });

    /**
     * L1 24시간 누적 → L2 승격 — /api/chat과 같은 규칙(lib/chat/emergency-evaluate 공유).
     * 결함(2026-10-06 적대 감사): 이 경로엔 승격이 없어, "입맛이 하나도 없어"·"기운이 하나도 없어"를
     *   하루 종일 혼잣말해도 보호자에게 아무것도 가지 않았다. 상시 감시는 대화가 어려운 어르신용이라
     *   /api/chat에서 대신 승격될 기회도 거의 없다 — 이 경로에서 L1은 죽은 규칙이었다.
     *   (승격된 발화는 2로 저장된다 — /api/chat과 같은 기존 설계)
     */
    const effectiveLevel = await applyL1Escalation(emergency, conv.id);

    // 저장 실패가 보호자 알림을 삼키지 않게 분리(2026-10-02, /api/chat과 동일 처방).
    let userMsgId: string | undefined;
    try {
      const msg = await prisma.message.create({
        data: {
          conversationId: conv.id, role: "user", content: toObservationContent(text),
          emergencyLevel: effectiveLevel > 0 ? effectiveLevel : null,
          emergencyEvidence: effectiveLevel > 0 ? `${emergency.category}:${emergency.evidence}` : null,
        },
        select: { id: true },
      });
      userMsgId = msg.id;
    } catch (e) {
      console.error("[observe-turn] 저장 실패 — 응급 알림은 계속 진행:", e instanceof Error ? e.message : e);
    }

    // 보호자 알림(L2+, 승격 포함) — 메인 경로와 동등한 안전망
    //   ⚠ `&& userMsgId` 제거: 저장 실패에도 발송은 간다(마킹만 생략).
    if (effectiveLevel >= 2) {
      const level = effectiveLevel as 2 | 3;
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

    return NextResponse.json({ ok: true, text, emergencyLevel: effectiveLevel });
  } catch (e) {
    console.error("[observe-turn]", e);
    /**
     * 최후 응급 안전망 — /api/chat과 동일 처방(2026-10-02). 이 경로는 응급 판정은 DB 전에
     *   하지만, 그 뒤 conversation 조회·생성이 실패하면 **알림까지 통째로 날아갔다**
     *   (알림 블록이 저장 블록 뒤에 있다). 전사만 성공했다면 알림은 나가야 한다.
     * 전사 자체가 실패한 경우엔 observed가 비어 있어 안전망도 미발동한다(평가할 발화가 없다).
     */
    if (observed) {
      await lastResortEmergency({
        sos: { userId, text: observed },
        userName: session.user.name || "사용자",
        companionName: "민지",
        minLevel: 2,
      }).catch((err) => console.error("[observe-turn] 최후 안전망 실패:", err));
    }
    return NextResponse.json({ error: "처리 중 오류" }, { status: 500 });
  }
}
