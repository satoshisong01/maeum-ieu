/**
 * T3 정신건강 검진 테이블 생성 (mental_session + mental_assessments).
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등(IF NOT EXISTS). 응답 원문은 저장하지 않음(점수만).
 */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode", "no-verify"); connStr = u.toString(); } catch { /* noop */ }
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mental_session (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        scale        TEXT NOT NULL DEFAULT 'PHQ9',
        status       TEXT NOT NULL DEFAULT 'active',  -- active | done | aborted
        current_item INTEGER NOT NULL DEFAULT 0,      -- 0=동의 대기, 1~9=진행 중 문항
        retry_used   BOOLEAN NOT NULL DEFAULT false,
        total        INTEGER,
        severity     TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ms_user_status ON mental_session(user_id, status, updated_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS mental_assessments (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES mental_session(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        item_no    INTEGER NOT NULL,
        score      INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT mental_assessments_session_item_key UNIQUE (session_id, item_no)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ma_user ON mental_assessments(user_id, created_at DESC)`);
    console.log("✓ mental_session + mental_assessments 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
