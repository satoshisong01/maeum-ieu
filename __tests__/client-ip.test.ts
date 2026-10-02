/**
 * 프록시 뒤 클라이언트 IP 추출 — **레이트리밋 우회 차단**.
 *
 * 결함(2026-10-02 AWS 이전 감사): signup 라우트가 XFF의 맨 **왼쪽**을 썼다.
 *   ALB는 실제 클라이언트 IP를 기존 XFF **뒤에** 붙이므로, 공격자가
 *   `X-Forwarded-For: 1.2.3.4` 한 줄만 보내면 헤더가 `1.2.3.4, <진짜 IP>`가 되고
 *   코드는 `1.2.3.4`를 키로 쓴다. 값을 매번 바꾸면 가입 한도(분당 10)가 사실상 무제한이 된다.
 *   미인증 엔드포인트라 봇이 계정을 무한 생성할 수 있고, 가입만으로 건강정보 스키마에 행이 생긴다.
 */
import { describe, it, expect, afterEach } from "vitest";
import { getClientIp } from "@/lib/client-ip";

const reqWith = (headers: Record<string, string>) => new Request("https://x.test/", { headers });
const SAVED = process.env.TRUSTED_PROXY_HOPS;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = SAVED;
});

describe("XFF는 오른쪽에서 센다", () => {
  it("단일 프록시: 맨 오른쪽이 실제 클라이언트", () => {
    // 🔒 "1.2.3.4"를 돌려주면 위조 값으로 한도가 우회된다
    expect(getClientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("위조 체인이 길어도 맨 오른쪽만 본다", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": "a, b, c, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("항목이 하나면 그 값", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("공백·빈 항목을 정리한다", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": " a , , 203.0.113.9 " }))).toBe("203.0.113.9");
  });
});

describe("홉 수 설정", () => {
  it("TRUSTED_PROXY_HOPS=2면 오른쪽에서 2번째 (CloudFront+ALB)", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(getClientIp(reqWith({ "x-forwarded-for": "spoof, 203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  it("홉 수가 체인보다 크면 맨 왼쪽으로 떨어진다 (하한)", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": "203.0.113.9" }), 5)).toBe("203.0.113.9");
  });

  it("잘못된 TRUSTED_PROXY_HOPS는 기본 1로 (빈 문자열·음수·문자)", () => {
    for (const v of ["", "-1", "abc", "0"]) {
      process.env.TRUSTED_PROXY_HOPS = v;
      expect(getClientIp(reqWith({ "x-forwarded-for": "spoof, 203.0.113.9" })), v).toBe("203.0.113.9");
    }
  });
});

describe("폴백", () => {
  it("XFF가 없으면 x-real-ip", () => {
    expect(getClientIp(reqWith({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });
  it("둘 다 없으면 unknown (throw 금지)", () => {
    expect(getClientIp(reqWith({}))).toBe("unknown");
  });
});

describe("호출부 계약", () => {
  it("signup 라우트가 getClientIp를 쓴다 (직접 파싱 금지)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/auth/signup/route.ts", "utf-8");
    expect(src).toMatch(/getClientIp\(req\)/);
    // 🔒 `.split(",")[0]`로 되돌아가면 우회가 되살아난다
    expect(src).not.toMatch(/x-forwarded-for.*split\(","\)\[0\]/);
  });
});
