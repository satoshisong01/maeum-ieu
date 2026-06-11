/**
 * prisma db push로 drop된 raw SQL 테이블 복구
 * - message_embeddings (pgvector)
 * - cognitive_assessments
 * - conversation_summary (계층적 요약 weekly→monthly→yearly)
 */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id       TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        content_text  TEXT NOT NULL,
        embedding     vector(768) NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS message_embeddings_user_embedding_idx
        ON message_embeddings USING hnsw (embedding vector_cosine_ops)
        WHERE user_id IS NOT NULL`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS message_embeddings_user_id_idx ON message_embeddings (user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cognitive_assessments (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
        message_id       TEXT REFERENCES "Message"(id) ON DELETE SET NULL,
        conversation_id  TEXT REFERENCES "Conversation"(id) ON DELETE SET NULL,
        domain           TEXT NOT NULL,
        score            INTEGER NOT NULL DEFAULT 0,
        confidence       DOUBLE PRECISION DEFAULT 0.5,
        evidence         TEXT,
        note             TEXT,
        session_date     DATE NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ca_user_date ON cognitive_assessments(user_id, session_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ca_domain ON cognitive_assessments(user_id, domain)`);

    // 계층적 요약 테이블 — lib/chat/summarizer.ts의 INSERT/SELECT 컬럼과 동일해야 함
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_summary (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
        conversation_id TEXT,
        period_start    TIMESTAMPTZ NOT NULL,
        period_end      TIMESTAMPTZ NOT NULL,
        summary         TEXT NOT NULL,
        key_facts       TEXT,
        message_count   INTEGER NOT NULL DEFAULT 0,
        level           TEXT NOT NULL DEFAULT 'weekly',
        parent_id       TEXT,
        is_active       BOOLEAN NOT NULL DEFAULT true,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cs_user_level ON conversation_summary(user_id, level, is_active, period_end DESC)`);

    console.log("✓ message_embeddings + cognitive_assessments + conversation_summary 복구 완료");
    const emb = await client.query(`SELECT COUNT(*) FROM message_embeddings`);
    const cog = await client.query(`SELECT COUNT(*) FROM cognitive_assessments`);
    const cs = await client.query(`SELECT COUNT(*) FROM conversation_summary`);
    console.log(`  message_embeddings rows: ${emb.rows[0].count} (이전 1438건은 재생성 필요)`);
    console.log(`  cognitive_assessments rows: ${cog.rows[0].count} (이전 117건은 복구 불가)`);
    console.log(`  conversation_summary rows: ${cs.rows[0].count} (drop됐다면 backfill-summary.ts로 재생성)`);
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
