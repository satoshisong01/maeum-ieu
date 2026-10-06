/**
 * Live 엔진 — "지금 말하는 중인가"(hasPendingUserSpeech) 판정.
 *
 * 왜(2026-10-06 재검토): 일일 한도 신호는 **직전 턴** 회송 응답이라 늦게 도착한다. 처음 구현은 도착하자마자
 *   세션을 닫아, 그 사이 어르신이 하고 있던 다음 발화(응급일 수 있다)가 서버에 가지 않고 버려졌다.
 *   이제 화면은 이 판정이 참이면 닫지 않는다(app/live/page.tsx). 판정 자체가 틀리면 그 보호가 무력해진다.
 *
 * 엔진의 서버 메시지 처리기(private handleMessage)를 직접 불러 실제 전사 누적 경로를 탄다.
 */
import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";

vi.mock("@/lib/chat/korean-particle", async (o) => ({ ...(await o<typeof import("@/lib/chat/korean-particle")>()) }));
const { LiveVoiceEngine } = await import("@/app/chat/live-voice");

function engine() {
  const turns: [string, string][] = [];
  const e = new LiveVoiceEngine({
    onState: () => {}, onUserTranscript: () => {}, onAiTranscript: () => {},
    onTurnComplete: (u: string, a: string) => { turns.push([u, a]); },
    onError: () => {},
  } as never);
  const feed = (sc: Record<string, unknown>) => (e as unknown as { handleMessage(m: unknown): void }).handleMessage({ serverContent: sc });
  return { e, feed, turns };
}

describe("hasPendingUserSpeech", () => {
  it("아무 말도 없으면 false", () => {
    expect(engine().e.hasPendingUserSpeech()).toBe(false);
  });

  it("사용자 전사가 쌓이는 중이면 true", () => {
    const { e, feed } = engine();
    feed({ inputTranscription: { text: "가슴이" } });
    expect(e.hasPendingUserSpeech()).toBe(true);
  });

  it("턴이 끝나 보고되면 비워진다 — 그 뒤 새 발화가 쌓이면 다시 true", () => {
    const { e, feed, turns } = engine();
    feed({ inputTranscription: { text: "오늘 산책했어" } });
    feed({ outputTranscription: { text: "좋으셨겠어요" } });
    feed({ turnComplete: true });
    expect(turns).toEqual([["오늘 산책했어", "좋으셨겠어요"]]);
    expect(e.hasPendingUserSpeech()).toBe(false);
    // 직전 턴 회송 응답(한도 신호)을 기다리는 사이 새 발화가 시작됐다
    feed({ inputTranscription: { text: "숨이 안 쉬어져" } });
    expect(e.hasPendingUserSpeech()).toBe(true);
  });

  it("AI 전사가 비어도 사용자 발화가 있으면 턴을 보고한다 (응급 판정 입력은 사용자 발화)", () => {
    const { feed, turns } = engine();
    feed({ inputTranscription: { text: "숨이 안 쉬어져" } });
    feed({ turnComplete: true });
    // 🔒 예전엔 `u && a`라 이 턴이 보고되지 않아 서버가 응급을 판정할 수 없었다
    expect(turns).toEqual([["숨이 안 쉬어져", ""]]);
  });
});

describe("화면이 그 판정을 쓴다", () => {
  it("한도로 닫기 전에 hasPendingUserSpeech를 확인한다", async () => {
    const src = await readFile("app/live/page.tsx", "utf-8");
    const block = src.slice(src.indexOf("} else if (dailyLimitMessage) {"), src.indexOf("setLimitReached(true);", src.indexOf("} else if (dailyLimitMessage) {")));
    expect(block).toMatch(/if \(engineRef\.current\?\.hasPendingUserSpeech\(\)\) return;/);
    // 확인이 stop()보다 **먼저** 와야 한다
    expect(block.indexOf("hasPendingUserSpeech")).toBeLessThan(block.indexOf("engineRef.current?.stop()"));
    // 마무리 인사는 말풍선만이 아니라 보이는 안내 + 읽어 주기로
    expect(block).toMatch(/setError\(dailyLimitMessage\)/);
    expect(block).toMatch(/speakNotice\(dailyLimitMessage\)/);
  });
});
