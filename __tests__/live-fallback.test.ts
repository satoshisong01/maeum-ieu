/**
 * Live 한도 뒤 응급 통로 — **구조 계약** 테스트.
 *
 * 2026-10-06 적대 감사: Live 일일 한도로 토큰이 거절되면 그날은 음성으로 응급을 말할 통로가 없었다.
 *   /chat(클래식 음성)은 한도 후에도 발화마다 응급을 판정하지만, 베타가 켜지면 /chat의 음성 버튼 네 곳이
 *   무조건 /live로 되돌려 보내 **순환**했다.
 *
 * ⚠ 왜 구조 테스트인가: 클라이언트 라우팅이라 이 환경에서 실행할 수 없고, Next의 page 파일은 임의 함수를
 *   export할 수 없어(빌드 오류) preferLive를 직접 부를 수도 없다. 대신 "우회로가 다시 생기지 않는다"를
 *   소스 수준에서 고정하고 변이로 검증했다. 실기기 확인은 Live 베타를 켤 때 런북 항목으로 한다.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";

let chat = "";
let live = "";
beforeAll(async () => {
  chat = await readFile("app/chat/page.tsx", "utf-8");
  live = await readFile("app/live/page.tsx", "utf-8");
});

describe("/chat — classic=1이면 /live로 되돌려 보내지 않는다", () => {
  it("베타 플래그를 직접 보고 /live로 보내는 곳이 없다 (전부 preferLive 경유)", () => {
    // 🔒 한 곳이라도 플래그를 직접 보면 그 버튼에서 다시 순환한다
    expect(chat).not.toMatch(/NEXT_PUBLIC_SHOW_LIVE_BETA === "1"\)\s*\{\s*router\.push\("\/live"\)/);
    const viaHelper = chat.match(/if \(preferLive\(\)\) \{ router\.push\("\/live"\); return; \}/g) ?? [];
    expect(viaHelper.length, "음성 진입점 네 곳이 모두 preferLive를 써야 한다").toBeGreaterThanOrEqual(4);
  });

  /**
   * 판정은 **행위**로 본다. 예전 구조 테스트는 소스에 `get("classic") === "1"`이 있는지만 봐서,
   *   반환값의 `!`를 지워 classic=1에서도 /live로 보내는 변이가 녹색이었다(2026-10-06 재검토).
   */
  it.each([
    ["베타 켜짐 · 기본 주소", "1", "", true],
    ["베타 켜짐 · classic=1 (한도 뒤 응급 통로)", "1", "?start=1&classic=1", false],
    ["베타 켜짐 · classic=0", "1", "?classic=0", true],
    ["베타 꺼짐", undefined, "", false],
    ["베타 꺼짐 · classic=1", "0", "?classic=1", false],
  ] as const)("%s → Live %s", async (_name, flag, search, expected) => {
    const { shouldPreferLive } = await import("@/lib/chat/live-preference");
    expect(shouldPreferLive(flag, search)).toBe(expected);
  });

  it("화면의 preferLive는 그 판정에 빌드 플래그와 **현재 주소**를 넘긴다", () => {
    const fn = chat.slice(chat.indexOf("function preferLive"), chat.indexOf("export default function ChatPage"));
    // 🔒 다른 값을 넘기면(예: 고정 문자열) 행위 테스트가 녹색이어도 화면은 순환한다
    expect(fn).toMatch(/return shouldPreferLive\(process\.env\.NEXT_PUBLIC_SHOW_LIVE_BETA, typeof window !== "undefined" \? window\.location\.search : ""\);/);
  });
});

describe("/live — 한도 화면에 응급 통로가 있다", () => {
  it("한도에 닿으면 클래식 음성(classic=1)으로, **호출어 없이 바로 듣는**(armed=1) 버튼을 보인다", () => {
    expect(live).toMatch(/\{limitReached && \(/);
    // 🔒 armed=1이 빠지면 호출어 대기로 열려, 버튼 문구대로 곧장 말한 응급이 서버에 가지 않는다(2026-10-06 재검토)
    expect(live).toMatch(/router\.push\("\/chat\?start=1&classic=1&armed=1"\)/);
  });

  it("/chat은 armed=1이면 마이크·대화가 준비된 뒤 세션을 바로 연다 (인사 끝 자동 청취에 기대지 않는다)", () => {
    expect(chat).toMatch(/armedStartRef\.current = new URLSearchParams\(window\.location\.search\)\.get\("armed"\) === "1";/);
    const at = chat.indexOf("if (!armedStartRef.current || !micAllowed || !alwaysOn || !conversationId || sessionActive) return;");
    expect(at, "준비 조건을 모두 보는 effect가 있어야 한다").toBeGreaterThan(-1);
    const body = chat.slice(at, at + 400);
    expect(body).toMatch(/sessionActiveRef\.current = true; setSessionActive\(true\);/);
    expect(body).toMatch(/wakeArmedRef\.current = true; setWakeArmed\(true\);/);
    expect(body).toMatch(/startRecordingRef\.current\(\)/);
  });

  it("세션 시작 거절과 세션 중 도달 두 경우 모두 한도 상태를 켠다", () => {
    const sets = live.match(/setLimitReached\(true\)/g) ?? [];
    expect(sets.length).toBeGreaterThanOrEqual(2);
  });
});
