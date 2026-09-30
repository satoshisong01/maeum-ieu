/**
 * Message(conversationId, createdAt) 인덱스 생성 — 운영 적용용.
 *
 * 왜: 대화 이력 조회가 매 턴 `WHERE "conversationId" = ? ORDER BY "createdAt" DESC`로 돈다.
 *   PostgreSQL은 Prisma 관계만으로 인덱스를 만들지 않아 실측상 **Seq Scan**이었다
 *   (2026-09-30 EXPLAIN ANALYZE: Rows Removed by Filter 13,934 — 전수 스캔).
 *   현재 규모에선 3ms지만 메시지가 늘면 매 턴 선형으로 느려진다.
 *
 * 안전성:
 *   - `IF NOT EXISTS` — 여러 번 실행해도 안전(멱등).
 *   - `CONCURRENTLY` — 쓰기 잠금 없이 생성(운영 중 적용 가능). 트랜잭션 밖에서 실행해야 함.
 *   - 추가만 하고 아무것도 지우지 않는다. `prisma db push`는 절대 쓰지 말 것(raw SQL 테이블 drop 사고 이력).
 *
 * 사용: npx tsx scripts/ops-create-message-index.ts
 *   실행 후 `npx prisma generate` (스키마의 @@index와 동기화)
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";

const NAME = "Message_conversationId_createdAt_idx";

async function main() {
  const before = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='Message' AND indexname=$1`, NAME);
  if (before.length > 0) {
    console.log(`이미 존재: ${NAME} — 변경 없음`);
    return;
  }

  console.log(`생성 시작: ${NAME} (CONCURRENTLY — 쓰기 잠금 없음)`);
  const t0 = Date.now();
  await prisma.$executeRawUnsafe(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${NAME}" ON "Message" ("conversationId", "createdAt" DESC)`);
  console.log(`생성 완료 (${Date.now() - t0}ms)`);

  const plan = await prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN SELECT * FROM "Message" WHERE "conversationId" = 'probe' ORDER BY "createdAt" DESC LIMIT 50`);
  const text = plan.map((p) => Object.values(p)[0]).join(" | ");
  console.log(`쿼리 계획: ${/Index Scan|Index Only/.test(text) ? "✓ 인덱스 사용" : "⚠ 여전히 Seq Scan"}`);
  console.log(`  ${text.slice(0, 200)}`);
}

main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
