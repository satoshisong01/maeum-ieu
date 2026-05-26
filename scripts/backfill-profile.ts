/**
 * 기존 사용자 메시지에서 profile 데이터 backfill.
 * 모든 user role 메시지를 시간순으로 순회하며 profile-extractor 적용.
 * 사용법: npx tsx scripts/backfill-profile.ts [email]
 *   email 생략 시 전체 사용자
 */
import "dotenv/config";
import { extractAndSaveProfile } from "../lib/chat/profile-extractor";
const { Pool } = require("pg");

async function main() {
  const emailFilter = process.argv[2];

  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode", "no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const userQuery = emailFilter
      ? `SELECT id, email FROM "User" WHERE email = $1`
      : `SELECT id, email FROM "User"`;
    const users = await c.query(userQuery, emailFilter ? [emailFilter] : []);
    console.log(`Processing ${users.rows.length} users...`);

    for (const u of users.rows) {
      const msgs = await c.query(`
        SELECT m.id, m.content
        FROM "Message" m
        JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE c."userId" = $1 AND m.role = 'user'
        ORDER BY m."createdAt" ASC
      `, [u.id]);

      let extracted = 0;
      for (const m of msgs.rows) {
        const result = await extractAndSaveProfile({
          userId: u.id, userMessage: m.content, userMessageId: m.id,
        });
        if (result.familyAdded.length + result.factsAdded.length + result.profileUpdated.length > 0) {
          extracted++;
        }
      }
      console.log(`  ${u.email}: ${msgs.rows.length} messages, ${extracted} extractions`);
    }

    // 결과 요약
    const summary = await c.query(emailFilter ? `
      SELECT u.email,
        (SELECT COUNT(*) FROM family_member fm WHERE fm.user_id = u.id) AS family_count,
        (SELECT COUNT(*) FROM user_fact uf WHERE uf.user_id = u.id) AS fact_count,
        EXISTS(SELECT 1 FROM user_profile p WHERE p.user_id = u.id) AS has_profile
      FROM "User" u WHERE u.email = $1
    ` : `
      SELECT u.email,
        (SELECT COUNT(*) FROM family_member fm WHERE fm.user_id = u.id) AS family_count,
        (SELECT COUNT(*) FROM user_fact uf WHERE uf.user_id = u.id) AS fact_count,
        EXISTS(SELECT 1 FROM user_profile p WHERE p.user_id = u.id) AS has_profile
      FROM "User" u
    `, emailFilter ? [emailFilter] : []);

    console.log("\n=== Backfill summary ===");
    for (const row of summary.rows) {
      console.log(`  ${row.email}: profile=${row.has_profile} family=${row.family_count} facts=${row.fact_count}`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
