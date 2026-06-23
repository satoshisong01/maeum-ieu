/**
 * TTS — Google Cloud Text-to-Speech (Vertex AI 게이트웨이).
 *
 * 2026-05-26: AI Studio Gemini TTS는 paid tier에서도 모델당 일일 100회 한도라
 *             사이클 마라톤 / 다중 사용자 시 quota 소진. Vertex AI Cloud TTS는
 *             별도 후한 quota 체계라 사실상 끊김 없음.
 *
 * 인증 방식 (둘 중 하나):
 *   - 로컬: GOOGLE_APPLICATION_CREDENTIALS = JSON 파일 경로 (.env)
 *   - Vercel: GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON 전체 내용 (single line)
 *             또는 GOOGLE_APPLICATION_CREDENTIALS_B64 = base64 인코딩
 *
 * 폴백 chain: Cloud TTS Neural2 → 기존 Gemini TTS → (실패 시 client가 Web Speech)
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { GoogleGenAI } from "@google/genai";
import textToSpeech from "@google-cloud/text-to-speech";
import { authOptions } from "@/lib/auth";
import { pcmToWav } from "@/lib/audio";
import { sanitizeForTts } from "@/lib/chat/tts-text";

const DEFAULT_VOICE_GEMINI = "Leda";          // Gemini TTS 음성
const DEFAULT_VOICE_CLOUD = "ko-KR-Neural2-A"; // Cloud TTS 한국어 여성 자연 음성
const MAX_TEXT_LENGTH = 1000;

// Gemini TTS fallback 모델 chain (Cloud TTS 실패 시)
const GEMINI_TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
];

interface ServiceAccountCredentials {
  type?: string;
  project_id?: string;
  private_key?: string;
  client_email?: string;
  [k: string]: unknown;
}

/** Vercel · 로컬 양쪽에서 인증 정보 로드 */
function loadCloudTtsCredentials(): ServiceAccountCredentials | null {
  // Vercel용: JSON 내용 직접 환경변수에 넣은 경우
  const jsonRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (jsonRaw) {
    try { return JSON.parse(jsonRaw); } catch { /* fall through */ }
  }
  // Vercel용 base64 변형
  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      return JSON.parse(decoded);
    } catch { /* fall through */ }
  }
  // 로컬용: 파일 경로 — SDK가 자동으로 GOOGLE_APPLICATION_CREDENTIALS 환경변수 인식
  return null;
}

let cloudTtsClient: InstanceType<typeof textToSpeech.TextToSpeechClient> | null = null;
function getCloudTtsClient() {
  if (cloudTtsClient) return cloudTtsClient;
  const creds = loadCloudTtsCredentials();
  if (creds && creds.client_email && creds.private_key) {
    cloudTtsClient = new textToSpeech.TextToSpeechClient({
      credentials: { client_email: creds.client_email, private_key: creds.private_key },
      projectId: creds.project_id || process.env.GCP_PROJECT_ID,
    });
  } else {
    // 로컬: 환경변수 GOOGLE_APPLICATION_CREDENTIALS가 파일 경로 자동 인식
    cloudTtsClient = new textToSpeech.TextToSpeechClient();
  }
  return cloudTtsClient;
}

async function synthesizeWithCloudTts(text: string, voice: string): Promise<Buffer> {
  const client = getCloudTtsClient();
  const [res] = await client.synthesizeSpeech({
    input: { text },
    voice: { languageCode: "ko-KR", name: voice },
    audioConfig: { audioEncoding: "MP3", speakingRate: 1.0, pitch: 0 },
  });
  if (!res.audioContent) throw new Error("Cloud TTS: empty audioContent");
  if (typeof res.audioContent === "string") return Buffer.from(res.audioContent, "base64");
  return Buffer.from(res.audioContent);
}

async function synthesizeWithGemini(text: string, voice: string): Promise<{ audio: Buffer; mimeType: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");
  const ai = new GoogleGenAI({ apiKey });
  let lastErr: unknown = null;
  for (const model of GEMINI_TTS_MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      const part = res?.candidates?.[0]?.content?.parts?.[0] as
        | { inlineData?: { data?: string; mimeType?: string } } | undefined;
      const dataB64 = part?.inlineData?.data;
      if (!dataB64) { lastErr = new Error(`empty inlineData (${model})`); continue; }
      const pcm = Buffer.from(dataB64, "base64");
      return { audio: pcmToWav(pcm), mimeType: "audio/wav" };
    } catch (e) { lastErr = e; /* try next model */ }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Gemini TTS all models failed");
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  // 고비용 TTS 폭주 방어 — 계정당 분당 40회
  const rl = await checkRateLimit(`tts:${session.user.id}`, 40, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  const body = await req.json().catch(() => ({}));
  const text: string = sanitizeForTts((body?.text || "").toString());
  if (!text) return NextResponse.json({ error: "text 필수" }, { status: 400 });
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `text는 ${MAX_TEXT_LENGTH}자 이하여야 합니다.` }, { status: 400 });
  }

  // 1차: Cloud TTS Neural2 (한국어 자연 음성, paid quota 후함)
  try {
    const voice = (body?.voice || DEFAULT_VOICE_CLOUD).toString();
    const audio = await synthesizeWithCloudTts(text, voice);
    return NextResponse.json({
      audioBase64: audio.toString("base64"),
      mimeType: "audio/mp3",
      voice,
      engine: "cloud-tts",
    });
  } catch (cloudErr) {
    console.warn("[tts] Cloud TTS failed, falling back to Gemini TTS:", (cloudErr as Error).message);
  }

  // 2차: Gemini TTS (preview 모델 chain)
  try {
    const voice = DEFAULT_VOICE_GEMINI;
    const { audio, mimeType } = await synthesizeWithGemini(text, voice);
    return NextResponse.json({
      audioBase64: audio.toString("base64"),
      mimeType,
      voice,
      engine: "gemini-tts",
    });
  } catch (geminiErr) {
    console.error("[tts] all TTS engines failed:", geminiErr);
    const msg = geminiErr instanceof Error ? geminiErr.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
