/**
 * Live API ephemeral token 발급 — 클라이언트가 Gemini Live(WebSocket)에 직결하기 위한 단기 토큰.
 * Vercel 서버리스는 상시 WS 불가 → 공식 패턴(클라 직결 + ephemeral token). API key는 서버에만 존재.
 *
 * PoC 단계(2026-06-12): 발급만 스캐폴드. 클라 통합은 VOICE_ENGINE=live 플래그 작업에서.
 * 실측 근거: scripts/poc-live-api.mjs — 첫 오디오 1.44s(현행 6.1s 대비 76%↓), 출력 전사 0.97s 선행.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { GoogleGenAI, Modality } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { getHonorific } from "@/lib/chat/prompt";

const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  // 토큰 발급 남용 방지 — 계정당 분당 10회(세션 재접속 여유 포함)
  const rl = await checkRateLimit(`live-token:${session.user.id}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "서버 설정 오류" }, { status: 500 });

  try {
    // 세션 config는 토큰에 박는다 — Constrained 연결에선 클라 config가 무시되며(전사 미수신 버그로 실증),
    // 서버가 페르소나·전사 설정을 고정하면 클라이언트 변조도 차단됨.
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { companionName: true, userHonorific: true, age: true, gender: true },
    });
    const companion = user?.companionName?.trim() || "민지";
    const honorific = user?.userHonorific?.trim() || getHonorific(user?.age ?? null, user?.gender ?? null);
    const systemInstruction = `당신은 다정한 AI 동반자 '${companion}'입니다. 사용자를 "${honorific}"라고만 부르되 매번 호명하지 말고(4~5번에 한 번), 1~3문장의 따뜻한 한국어로 자연스럽게 대화하세요. 사용자가 외워달라던 단어의 회상을 요청하면 정답을 절대 먼저 말하지 마세요. 의료·진단 단정은 금지하고, 위급해 보이면 119 연락을 부드럽게 권하세요.`;

    const ai = new GoogleGenAI({ apiKey });
    const token = await ai.authTokens.create({
      config: {
        uses: 1, // 1회 연결용 — 재연결 시 재발급
        expireTime: new Date(Date.now() + 30 * 60_000).toISOString(), // 세션 최대 30분
        newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(), // 2분 내 연결 시작
        liveConnectConstraints: {
          model: LIVE_MODEL, // 다른 모델로의 남용 차단
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // PoC: thinking 미제한 시 첫 오디오 +2.6s — Live 경로에선 0이 정상 작동(3/3 검증)
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    return NextResponse.json({ token: token.name, model: LIVE_MODEL });
  } catch (e) {
    console.error("[live-token] 발급 실패:", (e as Error).message);
    return NextResponse.json({ error: "토큰 발급에 실패했습니다." }, { status: 502 });
  }
}
