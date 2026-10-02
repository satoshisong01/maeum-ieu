/**
 * 테스트 계정 판별 회귀 — 운영 관제에서 합성 데이터를 제외하되,
 * **실사용자를 테스트로 오분류하지 않는다**는 계약을 고정한다.
 *
 * 오분류 방향이 비대칭이다: 테스트를 실사용자로 보면 거짓 경보 1건이지만,
 * 실사용자를 테스트로 보면 **그 어르신의 응급이 워치독에서 조용히 빠진다**.
 */
import { describe, it, expect } from "vitest";
import { isTestAccount } from "@/lib/test-accounts";

describe("테스트 계정으로 판정해야 하는 것", () => {
  for (const e of [
    "authz.elder@maeum.test",      // 실제로 매일 거짓 경보를 울리던 계정
    "convtest@maeum.test",
    "notifytest.guardian@maeum.test",
    "mp1_2026@example.com",
    "foo@example.net",
    "bar@EXAMPLE.ORG",             // 대소문자 무관
    "test1234@test.com",           // Play 심사 데모
    "x@thing.invalid",
  ]) {
    it(e, () => expect(isTestAccount(e)).toBe(true));
  }
});

describe("실사용자는 절대 테스트로 보지 않는다", () => {
  for (const e of [
    "ryu-im@daum.net",             // 실제 외부 가입자
    "jongwoo.first@gmail.com",
    "rudtjrch@naver.com",
    "someone@firstcorea.com",
    "a@maeum.kr",                  // 우리 도메인이지만 실사용 가능
    "tester@gmail.com",            // 'test'가 로컬파트에 있어도 실도메인이면 실사용자
    "contact@testing-lab.co.kr",   // 도메인에 'test'가 들어가도 예약 도메인이 아니다
  ]) {
    it(e, () => expect(isTestAccount(e)).toBe(false));
  }
  it("빈 값·null은 실사용자 취급(누락보다 오경보가 낫다)", () => {
    expect(isTestAccount(null)).toBe(false);
    expect(isTestAccount(undefined)).toBe(false);
    expect(isTestAccount("")).toBe(false);
  });
});

describe("워치독이 이 제외를 실제로 쓴다", () => {
  it("pilot-daily-check가 isTestAccount로 걸러내고 건수를 표시한다", async () => {
    const src = await (await import("node:fs/promises")).readFile("scripts/pilot-daily-check.ts", "utf-8");
    expect(src).toMatch(/isTestAccount\(u\?\.email\)/);
    // 🔒 조용히 버리면 "테스트라서 뺀 건지, 버그로 빠진 건지" 구별이 안 된다
    expect(src).toMatch(/테스트 계정 \$\{testSkipped\}건/);
  });
});
