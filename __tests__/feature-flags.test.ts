/**
 * Live 베타 서버 게이트 — **런타임에 끌 수 있어야 한다**.
 *
 * 결함(2026-10-02 AWS 이전 감사 #9): `NEXT_PUBLIC_SHOW_LIVE_BETA` 하나가 UI 노출과
 *   서버 인가를 동시에 맡고 있었다. NEXT_PUBLIC_*는 **빌드 시 번들에 인라인**되므로
 *   런타임 env를 바꿔도 반영되지 않는다 →
 *     · 사고가 나도 Live 경로를 **재빌드·재배포 없이는 끌 수 없다**
 *     · Docker 빌드 인자와 런타임 env가 갈리면 UI는 열려 있는데 API는 403(또는 반대)
 *   Live는 음성 스트리밍이라 사고 시 즉시 차단이 필요한 경로다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { isLiveBetaEnabledServer } from "@/lib/feature-flags";

const SAVED = {
  runtime: process.env.LIVE_BETA_ENABLED,
  pub: process.env.NEXT_PUBLIC_SHOW_LIVE_BETA,
};
const set = (k: string, v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

beforeEach(() => {
  delete process.env.LIVE_BETA_ENABLED;
  delete process.env.NEXT_PUBLIC_SHOW_LIVE_BETA;
});
afterEach(() => {
  set("LIVE_BETA_ENABLED", SAVED.runtime);
  set("NEXT_PUBLIC_SHOW_LIVE_BETA", SAVED.pub);
});

describe("기본은 꺼짐 — 켜는 것이 명시적이어야 한다", () => {
  it("둘 다 없으면 false", () => expect(isLiveBetaEnabledServer()).toBe(false));
  it("빈 문자열도 꺼짐 (ECS 빈 env 함정)", () => {
    process.env.LIVE_BETA_ENABLED = "";
    process.env.NEXT_PUBLIC_SHOW_LIVE_BETA = "";
    expect(isLiveBetaEnabledServer()).toBe(false);
  });
  it("'1'이 아닌 값은 꺼짐", () => {
    for (const v of ["0", "true", "yes", "on"]) {
      process.env.LIVE_BETA_ENABLED = v;
      expect(isLiveBetaEnabledServer(), v).toBe(false);
    }
  });
});

describe("런타임 플래그가 우선 — 재빌드 없이 끌 수 있어야 한다", () => {
  it("LIVE_BETA_ENABLED=1이면 켜진다", () => {
    process.env.LIVE_BETA_ENABLED = "1";
    expect(isLiveBetaEnabledServer()).toBe(true);
  });

  it("🔒 빌드 타임 플래그가 켜져 있어도 런타임이 0이면 **끈다** (긴급 차단)", () => {
    process.env.NEXT_PUBLIC_SHOW_LIVE_BETA = "1";   // 번들에 이미 박힌 상태
    process.env.LIVE_BETA_ENABLED = "0";            // 사고 대응으로 런타임에서 끔
    // 이게 true면 사고가 나도 재빌드·재배포 전까지 Live를 막을 수 없다
    expect(isLiveBetaEnabledServer()).toBe(false);
  });

  it("런타임 미설정이면 빌드 타임 값으로 하위호환", () => {
    process.env.NEXT_PUBLIC_SHOW_LIVE_BETA = "1";
    expect(isLiveBetaEnabledServer()).toBe(true);
  });
});

describe("호출부 계약 — 서버 인가는 이 함수만 쓴다", () => {
  it.each(["app/api/live/token/route.ts", "app/api/live/turn/route.ts"])(
    "%s가 NEXT_PUBLIC_* 를 직접 인가에 쓰지 않는다", async (file) => {
      const src = await readFile(file, "utf-8");
      expect(src).toMatch(/isLiveBetaEnabledServer\(\)/);
      // 🔒 직접 비교로 되돌아가면 런타임 차단 능력이 사라진다
      expect(src).not.toMatch(/process\.env\.NEXT_PUBLIC_SHOW_LIVE_BETA/);
    });
});
