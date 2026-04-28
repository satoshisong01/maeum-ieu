/**
 * 손녀 페르소나 후보 음성들 한 번에 생성해 /tmp에 저장.
 * 들어본 뒤 app/api/tts/route.ts의 DEFAULT_VOICE 변경.
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { writeFile } from "node:fs/promises";
import { pcmToWav } from "../lib/audio";

const SAMPLE_TEXT = "할아버지, 안녕하세요. 민지예요. 오늘 점심은 맛있게 드셨어요? 민지가 보고 싶어서 전화했어요.";
const CANDIDATES = ["Leda", "Kore", "Aoede", "Puck", "Charon", "Zephyr", "Fenrir", "Schedar"];

async function main() {
  const apiKey = process.env.GEMINI_API_KEY!;
  const ai = new GoogleGenAI({ apiKey });
  for (const voice of CANDIDATES) {
    const t0 = Date.now();
    try {
      const res = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: SAMPLE_TEXT }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      const dataB64: string | undefined = (res as any)?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!dataB64) { console.warn(`✗ ${voice} empty`); continue; }
      const wav = pcmToWav(Buffer.from(dataB64, "base64"));
      const path = `/tmp/voice-${voice}.wav`;
      await writeFile(path, wav);
      console.log(`✓ ${voice.padEnd(10)} ${Date.now() - t0}ms → ${path}`);
    } catch (e) {
      console.warn(`✗ ${voice}: ${(e as Error).message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
