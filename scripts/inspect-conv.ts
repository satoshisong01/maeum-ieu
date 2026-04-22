import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  const convId = process.argv[2] || "cmnzeyeop000104jofjo0v49j";
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT role, content, "isAnomaly", "createdAt"
       FROM "Message"
       WHERE "conversationId" = $1
       ORDER BY "createdAt" ASC`,
      [convId]
    );
    console.log(`\n=== conv ${convId} (${r.rows.length}건) ===\n`);
    for (const row of r.rows) {
      const anom = row.isAnomaly ? "🔴" : "  ";
      const empty = !row.content?.trim() ? " ❗빈응답" : "";
      const ts = new Date(row.createdAt).toISOString().slice(11, 19);
      console.log(`${ts} ${anom} [${row.role}]${empty} ${row.content?.slice(0, 180) || "(empty)"}`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
