/**
 * 기존 사용자 userHonorific 자동 backfill (age/gender 기반).
 * 이미 설정된 사용자는 건너뜀.
 */
import "dotenv/config";
const { Pool } = require("pg");

function autoHonorific(age: number | null, gender: string | null): string | null {
  if (age == null || gender == null) return null;
  if (age >= 60) return gender === "male" ? "할아버지" : gender === "female" ? "할머니" : null;
  if (age >= 40) return gender === "male" ? "아빠" : gender === "female" ? "엄마" : null;
  return null;
}

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT id, email, age, gender, "userHonorific" FROM "User"`);
    let updated = 0;
    for (const row of r.rows) {
      if (row.userHonorific) { console.log(`  skip ${row.email} (already=${row.userHonorific})`); continue; }
      const h = autoHonorific(row.age, row.gender);
      if (!h) { console.log(`  skip ${row.email} (cannot auto: age=${row.age}, gender=${row.gender})`); continue; }
      await c.query(`UPDATE "User" SET "userHonorific" = $1 WHERE id = $2`, [h, row.id]);
      console.log(`  ✓ ${row.email} → ${h}`);
      updated++;
    }
    console.log(`\n총 ${updated}명 업데이트`);
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
