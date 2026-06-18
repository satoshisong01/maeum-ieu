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
    // 평가(잠정 등급)·답변 커버리지·재질문·의사 보정(학력·시공간)
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS eval_band TEXT`);            // 잠정 등급(정상범위/경계/저하의심/자료부족)
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS coverage_status TEXT`);      // ok | insufficient
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS answered_domains INTEGER NOT NULL DEFAULT 0`); // 실제 응답한 영역 수
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS total_domains INTEGER`);     // 시행 영역 수
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS reask_count INTEGER NOT NULL DEFAULT 0`); // 현재 영역 재질문 횟수
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS education_years INTEGER`);   // 의사 입력 학력(년)
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS visuospatial_score INTEGER`);// 의사 입력 시공간(시계, 0~2)
    await client.query(`ALTER TABLE exam_session ADD COLUMN IF NOT EXISTS formal_band TEXT`);          // 학력보정 잠정 등급
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
    // 멱등성 — 같은 세션·항목은 1행만(재채점은 UPSERT). 중복 INSERT로 인한 점수 이중집계 방지.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_eis_session_item ON exam_item_score(session_id, item_id)`);
    // 한 (전문가,환자)당 진행 중(open) 세션 최대 1개 — 동시 시작/고아 세션 방지(부분 unique).
    //   기존 중복 open 세션은 최신만 남기고 정리한 뒤 인덱스 생성(인덱스 충돌 방지).
    await client.query(`
      UPDATE exam_session SET ended_at = now()
      WHERE ended_at IS NULL AND id NOT IN (
        SELECT DISTINCT ON (expert_user_id, patient_user_id) id FROM exam_session
        WHERE ended_at IS NULL ORDER BY expert_user_id, patient_user_id, started_at DESC
      )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_es_open ON exam_session(expert_user_id, patient_user_id) WHERE ended_at IS NULL`);
    console.log("✓ exam_session(+항목채점 컬럼) + exam_item_score 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
