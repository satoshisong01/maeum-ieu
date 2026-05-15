/**
 * 오늘 사이클 (A/B/C) 동안 발생한 사용자 발화별로
 * AI 응답 vs DB 판정(isAnomaly/analysisNote) 이중 대조
 */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const r = await c.query(`
      SELECT id, role, content, "isAnomaly", "analysisNote", "createdAt"
      FROM "Message"
      WHERE "conversationId" = 'cmni80oop000704lk3m8ayf3b'
        AND "createdAt" > now() - interval '3 hours'
      ORDER BY "createdAt" ASC
    `);
    console.log(`\n=== 최근 3시간 메시지 ${r.rows.length}건 ===\n`);
    let prevUser = "";
    for (const row of r.rows) {
      const t = new Date(row.createdAt).toISOString().slice(11,19);
      if (row.role === "user") {
        const flag = row.isAnomaly ? "🔴 이상" : row.isAnomaly === false ? "✓" : "  ";
        console.log(`${t} ${flag} [user] "${row.content.slice(0, 80)}"`);
        if (row.analysisNote) console.log(`         note: ${row.analysisNote.slice(0, 200)}`);
        prevUser = row.content;
      } else {
        console.log(`${t}    [ai]   "${row.content.slice(0, 100)}"`);
      }
    }

    // cognitive_assessments 같은 시간대
    const ca = await c.query(`
      SELECT user_id, domain, score, evidence, note, created_at
      FROM cognitive_assessments
      WHERE created_at > now() - interval '3 hours'
      ORDER BY created_at ASC
    `);
    console.log(`\n=== cognitive_assessments ${ca.rows.length}건 ===\n`);
    for (const row of ca.rows) {
      const t = new Date(row.created_at).toISOString().slice(11,19);
      const flag = row.score >= 2 ? "🔴" : row.score === 1 ? "⚠️" : "✓ ";
      console.log(`${t} ${flag} ${row.domain.padEnd(22)} score=${row.score} | ev: ${(row.evidence||'').slice(0,60)}`);
      if (row.note) console.log(`              note: ${row.note.slice(0,150)}`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
