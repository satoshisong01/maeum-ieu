/**
 * 유닛 테스트가 **운영 DB에 닿는 것을 구조적으로 불가능하게** 만든다.
 *
 * 왜 필요한가 (2026-10-02 실측):
 *   emergency-notify-isolated 테스트에서 `vi.doMock("@/lib/prisma")`가 **간헐적으로** 먹지 않아
 *   유닛 테스트가 실제 RDS에 `prisma.message.create`를 날렸다. FK 제약에 걸려 실패했으니
 *   이번엔 운이 좋았지만, 제약이 맞는 데이터였다면 **운영 DB에 조용히 행이 들어갔을 것이다.**
 *   목 체제를 파일 단위로 쪼개 그 인스턴스는 고쳤지만, 그건 그 인스턴스만 고친 것이다.
 *   목이 빗나가는 일은 또 생길 수 있고, 그때 피해가 "테스트 실패"로 끝나야 한다.
 *
 * 어떻게:
 *   테스트 모듈이 import되기 전에 DATABASE_URL을 **예약 도메인(.invalid, RFC 2606)**으로
 *   바꿔둔다. lib/prisma.ts는 import 시점에 이 값으로 어댑터를 만들므로, 목이 빗나가면
 *   DNS 해석 실패로 즉시 죽는다 — 운영 DB에 연결 자체가 성립하지 않는다.
 *   호스트명이 곧 지시문이라, 에러를 보는 사람이 바로 무엇을 해야 하는지 안다.
 *
 * 예외 — **명시적 opt-in만**: `LIVE_DB_TEST=1`
 *   __tests__/daily-limit.live.test.ts는 의도적으로 실제 DB에 붙는 통합 테스트다
 *   (기본은 skip, 로컬에서 플래그를 켤 때만 실행). 이 가드를 처음 넣을 때 그 경로를
 *   **같이 막아버렸다**(2026-10-06 발견) — 기본 스위트에선 skip이라 녹색으로 보였다.
 *   플래그는 사람이 직접 켜야 하므로 "목이 빗나가서" 켜지는 일은 없다.
 *   ⚠ 플래그를 켠 채 **전체** 스위트를 돌리면 모든 파일이 실 DB를 쓴다. 문서화된 사용법은
 *     `LIVE_DB_TEST=1 npx vitest run __tests__/daily-limit.live.test.ts` 한 파일뿐이다.
 *
 * ⚠ 이 파일은 vitest에서만 로드된다(vitest.config.ts setupFiles). 프로덕션·스크립트 경로는
 *   전혀 건드리지 않는다 — tsx로 돌리는 scripts/*는 실제 DB를 그대로 쓴다.
 */
export const BLOCKED_DATABASE_URL =
  "postgresql://blocked:blocked@unit-test-must-mock-lib-prisma.invalid:1/blocked?sslmode=disable";

if (process.env.LIVE_DB_TEST === "1") {
  console.warn(
    "[no-real-db] LIVE_DB_TEST=1 — 실제 DB 차단 가드를 **끈 채로** 실행한다. " +
    "이 플래그는 daily-limit.live.test.ts 한 파일용이다.",
  );
} else {
  process.env.DATABASE_URL = BLOCKED_DATABASE_URL;
  // 같은 이유로 DB를 타는 보조 경로도 막는다 — 있으면 쓰고, 없으면 무해하다
  delete process.env.DATABASE_SSL_NO_VERIFY;
}
