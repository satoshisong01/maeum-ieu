/**
 * ExpertPatient 테이블 + User.expertCode 컬럼 수동 생성 (T1 다환자 관리, 2026-06-11).
 * ⚠️ prisma db push 금지(raw 테이블 drop 사고 이력) — 이 스크립트로 적용 후 `npx prisma generate`.
 * 멱등(IF NOT EXISTS) — 재실행 안전.
 */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode", "no-verify"); connStr = u.toString(); } catch { /* noop */ }
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "expertCode" TEXT`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "User_expertCode_key" ON "User"("expertCode")`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "ExpertPatient" (
        "id"            TEXT PRIMARY KEY,
        "expertUserId"  TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        "patientUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        "status"        TEXT NOT NULL DEFAULT 'active',
        "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ExpertPatient_expertUserId_patientUserId_key" UNIQUE ("expertUserId", "patientUserId")
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS "ExpertPatient_expertUserId_idx" ON "ExpertPatient"("expertUserId")`);
    await client.query(`CREATE INDEX IF NOT EXISTS "ExpertPatient_patientUserId_idx" ON "ExpertPatient"("patientUserId")`);
    console.log("✓ User.expertCode + ExpertPatient 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
