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
 * ⚠ 이 파일은 vitest에서만 로드된다(vitest.config.ts setupFiles). 프로덕션·스크립트 경로는
 *   전혀 건드리지 않는다 — tsx로 돌리는 scripts/*는 실제 DB를 그대로 쓴다.
 *
 * 진짜 DB가 필요한 검증은 vitest가 아니라 scripts/e2e-*.mjs에서 한다(그쪽은 의도된 경로다).
 */
const BLOCKED =
  "postgresql://blocked:blocked@unit-test-must-mock-lib-prisma.invalid:1/blocked?sslmode=disable";

process.env.DATABASE_URL = BLOCKED;
// 같은 이유로 DB를 타는 보조 경로도 막는다 — 있으면 쓰고, 없으면 무해하다
delete process.env.DATABASE_SSL_NO_VERIFY;
