/**
 * 전문가 검진 세션 기록 테이블 — 검진 문답(Q&A)을 시간 구간으로 스코핑 + 의사 코멘트(환자 일지).
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등(IF NOT EXISTS).
 * 문답 원문은 이 세션 구간[started_at, ended_at] 안의 메시지만 전문가에게 노출(일상대화와 분리).
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
      CREATE TABLE IF NOT EXISTS exam_session (
        id              TEXT PRIMARY KEY,
        patient_user_id TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        expert_user_id  TEXT NOT NULL,
        conversation_id TEXT,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at        TIMESTAMPTZ,
        doctor_comment  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_es_patient ON exam_session(patient_user_id, started_at DESC)`);
    console.log("✓ exam_session 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
