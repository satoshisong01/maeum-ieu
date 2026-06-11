/** abc/rudtjrch 계정 존재 + 해시 형식 확인용 일회성 헬퍼 */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let cs = process.env.DATABASE_URL!;
  try { const u = new URL(cs); u.searchParams.set("sslmode", "no-verify"); cs = u.toString(); } catch {}
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT email, LEFT(password, 4) AS pw_prefix, LENGTH(password) AS pw_len, name, age, gender FROM "User" WHERE email IN ('abc@abc.com','rudtjrch@naver.com')`);
    console.log(r.rows);
  } finally { c.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
