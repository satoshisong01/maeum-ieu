import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const r = await c.query(`
      SELECT role, content, "createdAt"
      FROM "Message"
      ORDER BY "createdAt" DESC
      LIMIT 40
    `);
    for (const row of r.rows.reverse()) {
      const flag = /[a-zA-Z]{10,}/.test(row.content) ? "⚠️" : "  ";
      console.log(`${flag} [${row.role}] ${row.content.slice(0, 200).replace(/\n/g, "\\n")}`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
