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

/**
 * 통계용 판정과 워치독용 판정의 **의도적 비대칭**을 고정한다.
 *
 * 2026-10-02 결함: scripts/usage-stats.ts가 자체 TEST_PATTERNS만 쓰다가
 *   e2e가 만드는 `role_*@example.com`을 전부 '실사용자'로 집계했다(317중 285 불일치).
 *   그 숫자가 일일 상한·가격 결정의 근거였다 — 측정이 거짓이면 그 위 판단이 전부 거짓이다.
 */
describe("통계용 테스트 계정 판정 (usage-stats) — 워치독보다 공격적이어야 한다", () => {
  it("e2e 자동 생성 계정을 테스트로 분류한다", async () => {
    const { isTest } = await import("../scripts/usage-stats");
    // 🔒 이게 false가 되면 테스트 트래픽이 실사용량으로 집계돼 상한·가격을 잘못 정한다
    expect(isTest("role_user_1759300000@example.com")).toBe(true);
    expect(isTest("role_general_1759300001@example.com")).toBe(true);
  });

  it("사내·운영 계정도 실사용자로 세지 않는다", async () => {
    const { isTest } = await import("../scripts/usage-stats");
    for (const e of ["ops@firstcorea.com", "x@maeum.app", "y@maeum.kr", "z@admin.com"]) {
      expect(isTest(e), e).toBe(true);
    }
  });

  it("워치독(isTestAccount)보다 넓게 거른다 — 방향이 반대인 비대칭", async () => {
    const { isTest } = await import("../scripts/usage-stats");
    const { isTestAccount } = await import("../lib/test-accounts");
    // 워치독은 보수적이어야 한다(실사용자를 테스트로 오분류하면 응급이 감시에서 빠진다)
    expect(isTestAccount("ops@firstcorea.com")).toBe(false);
    // 통계는 공격적이어야 한다(테스트를 실사용자로 세면 사용량을 과대평가한다)
    expect(isTest("ops@firstcorea.com")).toBe(true);
  });
});

/**
 * 테스트 트래픽이 '실사용 지표'로 새어 들어가는 지점의 회귀 고정.
 *
 * 2026-10-02에 두 곳에서 같은 오염이 확인됐다:
 *   · scripts/usage-stats.ts — 일일 상한·가격 결정의 입력
 *   · app/api/admin/overview — 관리자 대시보드('전체 회원 317명', 실제 6명)
 * 한 곳만 고치면 F3(파서 드리프트)가 남는다. 두 지점 모두 고정한다.
 */
describe("실사용 지표에서 테스트 트래픽이 빠져 있다", () => {
  it("admin overview 요약이 실사용 행만 집계한다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/admin/overview/route.ts", "utf-8");
    // 🔒 요약 집계가 userRows(전수)로 되돌아가면 대시보드가 다시 거짓을 보고한다
    expect(src).toMatch(/const realRows = userRows\.filter\(\(u\) => !u\.isTest\)/);
    expect(src).toMatch(/totalUsers: realRows\.length/);
    for (const metric of ["activeToday", "active7d", "msgs7dTotal", "secs7dTotal"]) {
      const line = src.split("\n").find((l) => l.includes(`const ${metric} =`)) ?? "";
      expect(line, `${metric}는 realRows 기준이어야 한다`).toContain("realRows");
    }
  });

  it("admin overview가 테스트 행을 숨기지는 않는다 (관리자 디버깅용)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/admin/overview/route.ts", "utf-8");
    // 🔒 users: realRows 로 바뀌면 관리자가 테스트 계정 상태를 볼 수 없게 된다
    expect(src).toMatch(/users: userRows/);
    expect(src).toMatch(/isTest: isTestAccount/);
  });

  it("usage-stats가 공유 판정을 쓴다 (자체 목록으로 되돌아가면 실패)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("scripts/usage-stats.ts", "utf-8");
    expect(src).toMatch(/isTestAccount\(email\) \|\| TEST_PATTERNS/);
  });
});
