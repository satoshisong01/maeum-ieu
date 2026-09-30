/**
 * 이메일 정규화 회귀 — 관리자 권한 상승 경로 차단 (2026-10-01).
 *
 * 결함: `isAdminEmail`은 대소문자를 무시해 비교하는데 가입·로그인은 정규화하지 않았다.
 *   Postgres의 `@unique`는 대소문자를 구분하므로 관리자 이메일의 대문자 변형으로 가입하면
 *   중복 검사와 DB 유니크를 모두 통과해 별도 계정이 만들어지고, 그 계정이 관리자 권한을 얻었다.
 *   (`/api/admin/overview`는 전 회원 이름·이메일·역할·응급 이벤트를 반환한다)
 *   부수 결함: "Kim@x.com"으로 가입한 어르신이 "kim@x.com"으로 로그인하면 실패했다.
 *
 * 성격: 화이트박스 단위 + 보안 회귀. 실제 DB를 쓰지 않고 정규화 계약만 고정한다.
 */
import { describe, it, expect } from "vitest";
import { isAdminEmail } from "@/lib/admin";

/** 가입·로그인 양쪽이 공유해야 하는 정규화 규칙 */
const normalize = (e: string) => e.trim().toLowerCase();

describe("이메일 정규화 — 관리자 권한 상승 차단", () => {
  it("대문자·공백 변형이 모두 같은 값으로 정규화된다", () => {
    const variants = [
      "admin@maeum.test",
      "Admin@maeum.test",
      "ADMIN@MAEUM.TEST",
      "  Admin@Maeum.Test  ",
      "aDmIn@mAeUm.tEsT",
    ];
    const normalized = new Set(variants.map(normalize));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe("admin@maeum.test");
  });

  it("유니코드 켈빈 기호(U+212A)도 소문자 k로 접힌다 — 같은 우회 경로였다", () => {
    // U+212A(KELVIN SIGN)는 toLowerCase()에서 평범한 'k'가 된다.
    // 정규화가 없으면 "Kim@x.com"이 "kim@x.com"과 다른 계정으로 저장되면서
    // isAdminEmail 비교에서는 동일하게 취급됐다.
    expect("K".toLowerCase()).toBe("k");
    expect(normalize("Kim@x.com")).toBe("kim@x.com");
    expect(normalize("Kim@x.com")).toBe(normalize("KIM@x.com"));
  });

  it("isAdminEmail은 정규화된 값과 대문자 변형을 동일하게 본다(비교는 원래 대소문자 무시)", () => {
    const prev = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "admin@maeum.test";
    try {
      expect(isAdminEmail("admin@maeum.test")).toBe(true);
      // 대문자 변형도 true — 그래서 가입 시 정규화가 없으면 별도 계정이 관리자가 된다.
      expect(isAdminEmail("Admin@Maeum.Test")).toBe(true);
      // 정규화된 값으로 저장되면 변형 계정 자체가 만들어지지 않는다.
      expect(normalize("Admin@Maeum.Test")).toBe("admin@maeum.test");
    } finally {
      if (prev === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = prev;
    }
  });

  it("ADMIN_EMAILS 미설정 시 fail-closed — 아무도 관리자가 아니다", () => {
    const prev = process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_EMAILS;
    try {
      expect(isAdminEmail("admin@maeum.test")).toBe(false);
      expect(isAdminEmail("anyone@x.com")).toBe(false);
    } finally {
      if (prev !== undefined) process.env.ADMIN_EMAILS = prev;
    }
  });

  it("가입 라우트가 정규화된 이메일을 저장한다 — 소스 계약 확인", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/auth/signup/route.ts", "utf-8");
    // 저장 시 정규화된 값을 쓰는가
    expect(src).toMatch(/email:\s*emailNorm/);
    expect(src).toMatch(/email\.trim\(\)\.toLowerCase\(\)/);
    // 중복 검사도 정규화된 값을 쓰는가(대문자 변형 우회 차단)
    expect(src).toMatch(/emailNorm[\s\S]{0,120}findFirst|findFirst[\s\S]{0,200}emailNorm/);
  });

  it("로그인이 정규화된 이메일로 조회한다 — 소스 계약 확인", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("lib/auth.ts", "utf-8");
    expect(src).toMatch(/toLowerCase\(\)/);
    expect(src).toMatch(/email:\s*normalized/);
  });
});
