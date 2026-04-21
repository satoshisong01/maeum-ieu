import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  const r = await client.query(`
    SELECT content, "analysisNote"
    FROM "Message"
    WHERE role='user' AND "isAnomaly"=true
      AND (content ILIKE '%이발소%' OR content ILIKE '%커피%' OR content ILIKE '%텃밭%'
           OR content ILIKE '%이불 빨래%' OR content ILIKE '%병원 예약%'
           OR content ILIKE '%안경%' OR content ILIKE '%허리가 좀 결려%'
           OR content ILIKE '%안녕 민지야%' OR content ILIKE '%오늘 하루 잘 보냈니%')
    ORDER BY "createdAt" DESC
  `);
  for (const row of r.rows) {
    console.log(`"${row.content}"\n  note: ${row.analysisNote}\n`);
  }
  client.release();
  await pool.end();
}
main().catch(console.error);
