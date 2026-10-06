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

  it("preferLive는 classic=1을 존중한다", () => {
    const fn = chat.slice(chat.indexOf("function preferLive"), chat.indexOf("export default function ChatPage"));
    expect(fn).toMatch(/get\("classic"\) === "1"/);
    expect(fn).toMatch(/NEXT_PUBLIC_SHOW_LIVE_BETA !== "1"\) return false/);
  });
});

describe("/live — 한도 화면에 응급 통로가 있다", () => {
  it("한도에 닿으면 클래식 음성(classic=1)으로 가는 버튼을 보인다", () => {
    expect(live).toMatch(/\{limitReached && \(/);
    expect(live).toMatch(/router\.push\("\/chat\?start=1&classic=1"\)/);
  });

  it("세션 시작 거절과 세션 중 도달 두 경우 모두 한도 상태를 켠다", () => {
    const sets = live.match(/setLimitReached\(true\)/g) ?? [];
    expect(sets.length).toBeGreaterThanOrEqual(2);
  });
});
