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
    // Phase 2 — 항목단위 상태머신: 진행 순서·현재 영역·정식 총점
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS item_order TEXT`);     // 영역 시행 순서(JSON 배열)
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS current_item INTEGER NOT NULL DEFAULT 0`); // 현재 진행 영역 인덱스
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS total_score INTEGER`);  // 획득 점수
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS max_score INTEGER`);    // 만점(음성 시행 영역)
    await client.query(`
      CREATE TABLE IF NOT EXISTS exam_item_score (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES exam_session("id") ON DELETE CASCADE,
        item_id         TEXT NOT NULL,
        domain          TEXT NOT NULL,
        prompt          TEXT,
        answer          TEXT,
        score           INTEGER NOT NULL DEFAULT 0,
        max_points      INTEGER NOT NULL DEFAULT 0,
        reason          TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_eis_session ON exam_item_score(session_id)`);
    console.log("✓ exam_session(+항목채점 컬럼) + exam_item_score 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
