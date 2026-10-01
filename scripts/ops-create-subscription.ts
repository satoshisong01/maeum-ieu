/**
 * Subscription 테이블 생성 — 운영 적용용.
 *
 * 안전성:
 *   - `IF NOT EXISTS` — 멱등. 여러 번 실행해도 안전.
 *   - 추가만 하고 아무것도 지우지 않는다. `prisma db push`는 절대 쓰지 말 것
 *     (raw SQL 테이블 embeddings/cognitive_assessments를 drop한 사고 이력).
 *   - FK는 ON DELETE CASCADE — 계정 삭제 시 구독 레코드가 고아로 남지 않게.
 *
 * 사용: npx tsx scripts/ops-create-subscription.ts
 *   실행 후 `npx prisma generate` (스키마의 model Subscription과 동기화)
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";

const TABLE = "Subscription";

async function main() {
  const exists = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=$1`, TABLE);
  if (exists.length > 0) {
    console.log(`이미 존재: ${TABLE} — 컬럼·인덱스만 점검합니다`);
  } else {
    console.log(`생성 시작: ${TABLE}`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${TABLE}" (
        "id"                TEXT PRIMARY KEY,
        "purchaserUserId"   TEXT NOT NULL,
        "beneficiaryUserId" TEXT NOT NULL,
        "productId"         TEXT NOT NULL,
        "purchaseToken"     TEXT NOT NULL,
        "status"            TEXT NOT NULL DEFAULT 'active',
        "expiresAt"         TIMESTAMP(3),
        "verifiedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "revokedAt"         TIMESTAMP(3),
        "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Subscription_purchaser_fkey"
          FOREIGN KEY ("purchaserUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "Subscription_beneficiary_fkey"
          FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
    console.log("테이블 생성 완료");
  }

  // 멱등 인덱스 — purchaseToken은 유일(중복 등록·재전송 방어의 마지막 방어선)
  const ddl: [string, string][] = [
    ["Subscription_purchaseToken_key", `CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_purchaseToken_key" ON "${TABLE}" ("purchaseToken")`],
    ["Subscription_beneficiaryUserId_status_idx", `CREATE INDEX IF NOT EXISTS "Subscription_beneficiaryUserId_status_idx" ON "${TABLE}" ("beneficiaryUserId", "status")`],
    ["Subscription_purchaserUserId_idx", `CREATE INDEX IF NOT EXISTS "Subscription_purchaserUserId_idx" ON "${TABLE}" ("purchaserUserId")`],
  ];
  for (const [name, sql] of ddl) {
    await prisma.$executeRawUnsafe(sql);
    console.log(`  인덱스 확인: ${name}`);
  }

  const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, TABLE);
  console.log(`컬럼(${cols.length}): ${cols.map((c) => c.column_name).join(", ")}`);
  console.log("\n다음 단계: npx prisma generate");
}

main()
  .catch((e) => { console.error("실패:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
