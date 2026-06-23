/**
 * User에 건강정보 동의 컬럼 추가 (consentedAt, consentVersion).
 * ⚠️ prisma db push 금지 — 수동 ALTER(멱등 IF NOT EXISTS). 실행 후 schema.prisma 갱신 + prisma generate.
 */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode", "no-verify"); connStr = u.toString(); } catch { /* noop */ }
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "consentedAt" TIMESTAMPTZ`);
    await client.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "consentVersion" TEXT`);
    console.log("✓ User.consentedAt + consentVersion 추가 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
