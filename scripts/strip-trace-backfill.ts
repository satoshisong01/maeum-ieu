/**
 * 과거 저장된 AI 메시지 중 reasoning trace가 선두에 노출된 건을 stripReasoningTrace로 정리.
 */
import "dotenv/config";
const { Pool } = require("pg");

function stripReasoningTrace(text: string): string {
  if (!text) return text;
  let t = text.trim();
  if (!t) return t;
  t = t.replace(/^\s*(?:```(?:thinking|thought)?\s*)?(?:thought|thinking|reasoning|analysis|plan|scratchpad)\s*:?\s*/i, "");
  t = t.replace(/^\s*\*{2,}\s*(?:thought|thinking|reasoning|analysis)[^*\n]*\*{2,}\s*/gi, "");
  const segments = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
  if (segments.length === 0) return t;
  const hasHangul = (s: string) => /[가-힣]/.test(s);
  const hangulRatio = (s: string) => {
    const han = (s.match(/[가-힣]/g) || []).length;
    const letters = (s.match(/[a-zA-Z가-힣]/g) || []).length;
    return letters === 0 ? 0 : han / letters;
  };
  if (!hasHangul(t)) return t;
  let startIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    if (hangulRatio(segments[i]) >= 0.4) { startIdx = i; break; }
    if (i === segments.length - 1) startIdx = 0;
  }
  return segments.slice(startIdx).join(" ").trim();
}

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  let changed = 0, scanned = 0;
  try {
    const r = await c.query(`
      SELECT id, content FROM "Message"
      WHERE role='assistant'
        AND (content ~* '^\\s*(thought|thinking|reasoning|analysis|plan|scratchpad)\\s'
          OR content ~* '^\\s*\\*\\*(thought|thinking|reasoning|analysis)')
    `);
    for (const row of r.rows) {
      scanned++;
      const cleaned = stripReasoningTrace(row.content);
      if (cleaned && cleaned !== row.content) {
        await c.query(`UPDATE "Message" SET content=$1 WHERE id=$2`, [cleaned, row.id]);
        changed++;
        console.log(`  fixed ${row.id}: "${cleaned.slice(0, 80)}"`);
      }
    }
    console.log(`\n✓ ${scanned}건 스캔, ${changed}건 정리`);
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
