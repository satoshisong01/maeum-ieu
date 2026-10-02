/**
 * 테스트 계정 판별 — 운영 지표·관제에서 합성 데이터를 제외하기 위한 단일 출처.
 *
 * 왜 필요한가: 검증용 응급 발화("가슴이 아프고 숨이 안 쉬어져")가 일일 점검 워치독에
 *   🔴 긴급으로 잡혀 매일 아침 경보가 울렸다(2026-10-01~02). 테스트 잔재가 매일 울리면
 *   **진짜 경보를 무시하게 된다**. 지표 왜곡보다 이 '늑대소년' 효과가 더 위험하다.
 *
 * 판정 기준은 **예약 도메인만** 쓴다(RFC 2606/6761). 사람 이름·가입 시점 같은 휴리스틱은
 *   실사용자를 테스트로 오분류할 수 있어 쓰지 않는다 — 오분류되면 그 어르신의 응급이
 *   워치독에서 조용히 빠진다.
 */

/** RFC 2606/6761 예약 TLD + 예약 도메인 + 이 프로젝트의 데모 계정 도메인 */
const TEST_SUFFIXES = [
  ".test", ".example", ".invalid", ".localhost",   // RFC 2606/6761 예약 TLD
  "@example.com", "@example.net", "@example.org",  // RFC 2606 예약 도메인
  "@test.com",                                      // Play 심사 데모 계정(test1234@test.com)
] as const;

/** 이 이메일이 테스트·데모 계정인가. 판단이 서지 않으면 false(=실사용자로 간주). */
export function isTestAccount(email: string | null | undefined): boolean {
  if (!email) return false;                 // 알 수 없으면 실사용자 취급 — 누락보다 오경보가 낫다
  const e = email.trim().toLowerCase();
  return TEST_SUFFIXES.some((s) => (s.startsWith("@") ? e.endsWith(s) : e.endsWith(s)));
}
