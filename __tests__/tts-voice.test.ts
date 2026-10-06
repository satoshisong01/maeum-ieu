/**
 * /api/tts — 음성은 **서버가 정한다** (클라이언트 voice 무시). 2026-10-06 적대 감사.
 *
 * 이전: body.voice를 Cloud TTS voice.name으로 그대로 넘겼다. 엉뚱한 voice로 Cloud TTS를 일부러 실패시키면
 *   Gemini 폴백(프로젝트 공용, 모델당 하루 100회)이 소진됐다 — 그날 Cloud TTS가 흔들리면 모든 어르신의
 *   음성 출력이 폴백 없이 끊긴다. 더 비싼 음성 등급을 골라 단가를 올릴 수도 있었다.
 *
 * 목 체제: 세션·레이트리밋·Cloud TTS 클라이언트·Gemini(폴백이 불리면 기록).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cloudCalls: { voice: { name: string } }[] = [];
let geminiCalls = 0;

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { id: "u-1", screeningMode: "user" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@google-cloud/text-to-speech", () => ({
  default: {
    TextToSpeechClient: class {
      async synthesizeSpeech(req: { voice: { name: string } }) {
        cloudCalls.push(req);
        // 실제 Cloud TTS처럼, 모르는 voice면 실패한다
        if (req.voice.name !== "ko-KR-Neural2-A") throw new Error("invalid voice");
        return [{ audioContent: Buffer.from("mp3") }];
      }
    },
  },
}));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class { models = { generateContent: async () => { geminiCalls++; throw new Error("not in test"); } }; },
}));

const { POST } = await import("@/app/api/tts/route");

async function tts(body: Record<string, unknown>) {
  const res = await POST(new Request("http://localhost/api/tts", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => { cloudCalls.length = 0; geminiCalls = 0; });

describe("음성 선택은 서버 몫", () => {
  it("클라가 엉뚱한 voice를 보내도 서버 기본 음성으로 합성하고, Gemini 폴백으로 새지 않는다", async () => {
    const r = await tts({ text: "안녕하세요", voice: "x-invalid-voice" });
    expect(r.status).toBe(200);
    // 🔒 이전: invalid voice → Cloud 실패 → Gemini 폴백(공용 일일 쿼터) 소진
    expect(cloudCalls.map((c) => c.voice.name)).toEqual(["ko-KR-Neural2-A"]);
    expect(geminiCalls).toBe(0);
  });

  it("voice를 안 보내는 정상 요청도 그대로", async () => {
    const r = await tts({ text: "안녕하세요" });
    expect(r.status).toBe(200);
    expect(cloudCalls.map((c) => c.voice.name)).toEqual(["ko-KR-Neural2-A"]);
  });
});
