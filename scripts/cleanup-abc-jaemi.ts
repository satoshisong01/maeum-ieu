/** abc 계정의 잘못 박힌 "재미" family_member row 1건 삭제 (잘못된 추출로 박힌 잔여 데이터) */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let cs = process.env.DATABASE_URL!;
  try { const u = new URL(cs); u.searchParams.set("sslmode", "no-verify"); cs = u.toString(); } catch {}
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const u = await c.query(`SELECT id FROM "User" WHERE email = 'abc@abc.com'`);
    if (u.rowCount === 0) { console.log("abc not found"); return; }
    const uid = u.rows[0].id;

    const before = await c.query(`SELECT id, relation, name FROM family_member WHERE user_id = $1 AND name = '재미'`, [uid]);
    console.log(`Before: ${before.rowCount} '재미' rows`);
    for (const r of before.rows) console.log(`  → ${r.id} (${r.relation})`);

    const del = await c.query(`DELETE FROM family_member WHERE user_id = $1 AND name = '재미' RETURNING id`, [uid]);
    console.log(`Deleted: ${del.rowCount} rows`);

    const after = await c.query(`SELECT id, relation, name FROM family_member WHERE user_id = $1`, [uid]);
    console.log(`\nAfter (abc family_member):`);
    for (const r of after.rows) console.log(`  ${r.relation} = ${r.name}`);
  } finally { c.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
