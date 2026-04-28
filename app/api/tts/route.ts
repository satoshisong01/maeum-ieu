/**
 * Gemini 3.1 Flash TTS Preview — 텍스트를 base64 WAV 오디오로 변환.
 * 클라이언트는 응답을 data URL로 만들어 <audio>에 재생.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenAI } from "@google/genai";
import { authOptions } from "@/lib/auth";
import { pcmToWav } from "@/lib/audio";

const TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_VOICE = "Leda"; // 밝고 따뜻한 여성 톤 (손녀 페르소나)
const MAX_TEXT_LENGTH = 1000; // 비용 가드: 너무 긴 텍스트 차단

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY 미설정" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const text: string = (body?.text || "").toString().trim();
  const voice: string = (body?.voice || DEFAULT_VOICE).toString();

  if (!text) {
    return NextResponse.json({ error: "text 필수" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `text는 ${MAX_TEXT_LENGTH}자 이하여야 합니다.` }, { status: 400 });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const part = res?.candidates?.[0]?.content?.parts?.[0] as
      | { inlineData?: { data?: string; mimeType?: string } }
      | undefined;
    const dataB64 = part?.inlineData?.data;
    if (!dataB64) {
      console.warn("[tts] empty inlineData", JSON.stringify(res).slice(0, 500));
      return NextResponse.json({ error: "TTS 응답이 비어있습니다." }, { status: 502 });
    }

    const pcm = Buffer.from(dataB64, "base64");
    const wav = pcmToWav(pcm);
    return NextResponse.json({
      audioBase64: wav.toString("base64"),
      mimeType: "audio/wav",
      voice,
    });
  } catch (e) {
    console.error("[tts] generate error:", e);
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
