/**
 * Gemini 3.1 Flash TTS Preview 스모크 테스트.
 * 한국어 한 문장 → WAV 파일 저장 → 길이/크기 확인.
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { writeFile } from "node:fs/promises";
import { pcmToWav } from "../lib/audio";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const ai = new GoogleGenAI({ apiKey });
  const text = "할아버지, 오늘 점심은 맛있게 드셨어요? 민지가 보고 싶어서 전화했어요.";
  const voice = process.argv[2] || "Leda";

  console.log(`> voice=${voice}, text="${text}"`);
  const t0 = Date.now();
  const res = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const elapsed = Date.now() - t0;

  const part = (res as any)?.candidates?.[0]?.content?.parts?.[0];
  const dataB64: string | undefined = part?.inlineData?.data;
  const mimeType: string = part?.inlineData?.mimeType || "(unknown)";
  if (!dataB64) {
    console.error("empty audio. raw:", JSON.stringify(res).slice(0, 800));
    process.exit(1);
  }
  const pcm = Buffer.from(dataB64, "base64");
  const wav = pcmToWav(pcm);
  const out = `/tmp/tts-${voice}.wav`;
  await writeFile(out, wav);
  console.log(`✓ ${elapsed}ms, mime=${mimeType}, pcm=${pcm.length}B, wav=${wav.length}B → ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
