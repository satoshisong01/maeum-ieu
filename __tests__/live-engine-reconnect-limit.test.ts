/**
 * Live 엔진 — **재연결** 도중 일일 한도에 닿았을 때.
 *
 * 결함(2026-10-06 재검토, 재현 확인): 세션이 15분(오디오 상한)마다 닫히면 엔진이 새 토큰으로 다시 붙는다.
 *   그때 토큰 발급이 한도로 거절되면 엔진은 onError(문구)만 불렀다. 화면은 문구만 띄우고
 *   **응급 통로 버튼(한도 뒤 "급한 일이 있으세요?")을 띄우지 않았다** — 첫 연결 실패(start()의 catch)만
 *   그 버튼을 켰기 때문이다. 게다가 stopped 플래그만 세워 **마이크가 켜진 채** 남았다.
 *
 * 목 체제: @google/genai(live.connect 콜백 포획) + fetch(토큰 발급). 엔진 코드는 실물.
 */
import { describe, it, expect, vi } from "vitest";

type Callbacks = { onclose: (e: unknown) => void; onopen: () => void };
const connects: Callbacks[] = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    live = {
      connect: async ({ callbacks }: { callbacks: Callbacks }) => {
        connects.push(callbacks);
        return { sendRealtimeInput: () => {}, close: () => {} };
      },
    };
  },
}));

const LIMIT_MSG = "할머니, 오늘은 이야기를 많이 나눴어요. 내일 또 이야기해요.";
let tokenCalls = 0;
vi.stubGlobal("fetch", vi.fn(async () => {
  tokenCalls++;
  // 첫 발급은 성공, 재연결 발급은 한도 거절
  if (tokenCalls === 1) return new Response(JSON.stringify({ token: "t", model: "m" }), { status: 200 });
  return new Response(JSON.stringify({ dailyLimitReached: true, message: LIMIT_MSG }), { status: 429 });
}));

const { LiveVoiceEngine } = await import("@/app/chat/live-voice");

describe("재연결이 한도로 거절되면", () => {
  it("화면에 한도를 알리고(onDailyLimit) 마이크를 닫고 더 붙지 않는다", async () => {
    const states: string[] = [];
    const errors: string[] = [];
    const limits: string[] = [];
    const engine = new LiveVoiceEngine({
      onState: (s) => states.push(s), onUserTranscript: () => {}, onAiTranscript: () => {},
      onTurnComplete: () => {}, onError: (m) => errors.push(m),
      onDailyLimit: (m) => limits.push(m),
    });
    await engine.start({ fakeMic: true, conversationId: "c-1" });
    // 실제 마이크 대신 트랙 정지를 관찰할 수 있는 가짜를 꽂는다
    const trackStop = vi.fn();
    (engine as unknown as { micStream: unknown }).micStream = { getTracks: () => [{ stop: trackStop }] };

    connects[0].onclose({ code: 1000 }); // 15분 상한으로 세션 종료 → 재연결 시도
    await vi.waitFor(() => expect(limits).toEqual([LIMIT_MSG]));

    // 🔒 2026-10-06 이전: onError만 불려 응급 통로 버튼이 안 떴다
    expect(errors).toContain(LIMIT_MSG);
    expect(states.at(-1)).toBe("stopped");
    // 🔒 stopped 플래그만 세우면 마이크가 켜진 채 남는다
    expect(trackStop).toHaveBeenCalled();
    // 마무리 인사가 재시도마다 반복되지 않는다
    expect(tokenCalls).toBe(2);
  });
});

describe("화면이 그 신호를 받는다", () => {
  it("app/live/page.tsx가 onDailyLimit에서 응급 통로 버튼을 켜고 읽어 준다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("app/live/page.tsx", "utf-8");
    // 🔒 엔진만 고치고 화면이 안 받으면 같은 증상이 남는다
    expect(src).toMatch(/onDailyLimit: \(m\) => \{ setLimitReached\(true\); speakNotice\(m\); \}/);
  });
});
