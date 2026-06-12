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
import { GoogleGenAI } from "@google/genai";
import { checkRateLimit } from "@/lib/rate-limit";

const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  // 토큰 발급 남용 방지 — 계정당 분당 10회(세션 재접속 여유 포함)
  const rl = checkRateLimit(`live-token:${session.user.id}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "서버 설정 오류" }, { status: 500 });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const token = await ai.authTokens.create({
      config: {
        uses: 1, // 1회 연결용 — 재연결 시 재발급
        expireTime: new Date(Date.now() + 30 * 60_000).toISOString(), // 세션 최대 30분
        newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(), // 2분 내 연결 시작
        liveConnectConstraints: { model: LIVE_MODEL }, // 다른 모델로의 남용 차단
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    return NextResponse.json({ token: token.name, model: LIVE_MODEL });
  } catch (e) {
    console.error("[live-token] 발급 실패:", (e as Error).message);
    return NextResponse.json({ error: "토큰 발급에 실패했습니다." }, { status: 502 });
  }
}
