/**
 * Live API ephemeral token 발급 — 클라이언트가 Gemini Live(WebSocket)에 직결하기 위한 단기 토큰.
 * Vercel 서버리스는 상시 WS 불가 → 공식 패턴(클라 직결 + ephemeral token). API key는 서버에만 존재.
 *
 * 2026-07-20 본선 승격 1차: 페르소나를 한 줄 지시문에서 본선 프롬프트 체계(buildSystemPrompt의
 * stablePrompt = 기본 페르소나 + 호칭 규칙 + 사용자 프로필 + 과거 대화 요약)로 교체.
 * 모델도 3.1-flash-live로 — 입력 전사 품질이 인지분석 가용 수준으로 확인됨(PoC 재측정:
 * "무릎이 좀 시큰거려서" 완벽 전사 · 첫 오디오 1.30s · 79% 단축. 2.5-native-audio는 "무료 피" 오전사).
 *
 * 토큰 제약 크기: liveConnectConstraints.systemInstruction 14,000자까지 발급 검증(2026-07-20).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { GoogleGenAI, Modality } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { getTimeContext } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";

const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-3.1-flash-live-preview";
// 발급 검증된 상한(14k)에서 여유를 둔 캡 — 프로필·요약이 비대해도 토큰 발급이 막히지 않게
const MAX_INSTRUCTION_LENGTH = 13000;

export async function POST(req: Request) {
  // 라이브는 재구축 중 경로(2026-07-20 파일럿 일시중단) — 플래그 켠 환경에서만 발급.
  if (process.env.NEXT_PUBLIC_SHOW_LIVE_BETA !== "1") {
    return NextResponse.json({ error: "라이브 베타는 현재 비활성화되어 있습니다." }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;

  // 토큰 발급 남용 방지 — 계정당 분당 10회(세션 재접속 여유 포함)
  const rl = await checkRateLimit(`live-token:${userId}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "서버 설정 오류" }, { status: 500 });

  // conversationId(선택) — 소유권 확인 후 프롬프트 빌드에 사용(검진 이력·요약 조회 키)
  const body = await req.json().catch(() => ({} as { conversationId?: string }));
  let conversationId: string | undefined;
  if (typeof body?.conversationId === "string") {
    const conv = await prisma.conversation.findUnique({ where: { id: body.conversationId.slice(0, 100) }, select: { userId: true } });
    if (conv && conv.userId === userId) conversationId = body.conversationId.slice(0, 100);
  }

  try {
    // 본선 프롬프트의 안정 프리픽스(페르소나·호칭 규칙·프로필·요약)를 세션 지시문으로 —
    // 검진(pro) 흐름은 Live 미지원이라 일반인 외에는 사용자 모드로 고정.
    const mode = session.user.screeningMode === "general" ? "general" : "user";
    const timeCtx = getTimeContext();
    const weather = await getWeatherContext(); // 좌표 없음 — 기본 지역 폴백(세션 시작 시점 스냅샷)
    const { stablePrompt } = await buildSystemPrompt({ userId, conversationId, timeCtx, weather, mode });

    const liveGuide = `

[라이브 음성 대화 — 세션 지시]
- 현재 한국 시각: ${timeCtx.dateStr} (${timeCtx.timeLabel}). 날씨: ${weather.promptText || weather.description}
- 실시간 음성 대화입니다. 기본 2문장 이내(120자)로 짧게, 질문은 한 번에 하나만.
- 대여섯 턴에 한 번쯤 날짜·요일·식사·최근 기억 같은 가벼운 확인을 수다에 자연스럽게 섞으세요. 검사하는 느낌 절대 금지.
- 사용자가 외워달라던 단어·계산 답 등 평가성 항목은 사용자가 못 떠올려도 정답을 절대 먼저 말하지 마세요.
- 위급 신호(가슴 통증·호흡곤란·쓰러짐·자살 암시)가 보이면 공감 후 즉시 119·보호자 연락을 부드럽지만 단호하게 권하세요.`;

    let systemInstruction = `${stablePrompt}${liveGuide}`;
    if (systemInstruction.length > MAX_INSTRUCTION_LENGTH) {
      // 과대 시 안정 프리픽스 뒤쪽(요약부)이 잘리도록 앞에서부터 보존
      systemInstruction = systemInstruction.slice(0, MAX_INSTRUCTION_LENGTH - liveGuide.length) + liveGuide;
    }

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
            // PoC: thinking 미제한 시 첫 오디오 +2.6s — Live 경로에선 0이 정상 작동(3.1에서도 검증)
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
