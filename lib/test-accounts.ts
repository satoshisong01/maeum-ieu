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

/**
 * ── 지표용 판정 (위 워치독용과 **방향이 반대**다) ──────────────────────────────
 *
 * 두 판정자가 따로 있는 것은 의도적이다. 틀렸을 때의 피해가 반대 방향이기 때문이다:
 *   · isTestAccount (응급 워치독용) — **보수적**. 실사용자를 테스트로 오분류하면
 *     그 어르신의 응급이 감시에서 조용히 빠진다. 그래서 예약 도메인만 본다.
 *   · isInternalOrTestAccount (지표·통계용) — **공격적**. 테스트·사내 계정을 실사용자로
 *     세면 사용량·회원수를 과대평가해 상한·가격을 잘못 정한다. 그래서 더 넓게 걸러낸다.
 * 이 설명이 사라지면 누군가 "일관성"을 이유로 하나로 합칠 텐데, 그러면 둘 중 하나가 틀려진다.
 *
 * ⚠ 이 함수가 `lib/`에 있는 이유: 원래 scripts/usage-stats.ts 안에만 있어서 **앱 코드가
 *   쓸 수 없었다**. 그래서 관리자 대시보드는 보수적 판정을 쓸 수밖에 없었고, 같은 질문
 *   ("실사용자 몇 명인가")에 통계는 6명, 대시보드는 16명을 답했다 — 사내·QA 계정 10개가
 *   경영 판단에 실사용자로 섞여 들어갔다(2026-10-02 적발). 판정자가 소비처마다 흩어지면
 *   드리프트는 시간문제다(가이드 F3). 지표용 판정은 여기 하나만 둔다.
 */
const INTERNAL_PATTERNS = [
  /@maeum\.test$/i, /@test\.com$/i, /^test/i, /^convtest/i, /^modeltest/i,
  /^notifytest/i, /^abc/i, /^rudtjrch/i, /demo/i, /^qa/i, /playwright/i,
  /^role_/i,                 // scripts/e2e-roles.mjs 자동 생성 계정
  /@(maeum\.app|maeum\.kr|firstcorea\.com|admin\.com)$/i,  // 사내·운영 계정(실사용자 아님)
];

/** 실사용 지표에서 제외할 계정인가 — 테스트 + 사내·QA·데모까지 포함한다. */
export function isInternalOrTestAccount(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim();
  return isTestAccount(e) || INTERNAL_PATTERNS.some((p) => p.test(e));
}
