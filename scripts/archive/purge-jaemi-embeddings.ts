/** abc 계정의 message_embeddings에서 "재미" 포함 row 정리 (옛 테스트 데이터) */
import "dotenv/config";
const { Pool } = require("pg");

async function main() {
  let cs = process.env.DATABASE_URL!;
  try { const u = new URL(cs); u.searchParams.set("sslmode", "no-verify"); cs = u.toString(); } catch {}
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const u = await c.query(`SELECT id FROM "User" WHERE email = 'abc@abc.com'`);
    const uid = u.rows[0].id;

    const before = await c.query(`SELECT COUNT(*) AS n FROM message_embeddings WHERE user_id = $1 AND content_text ILIKE '%재미%'`, [uid]);
    console.log(`Before: ${before.rows[0].n} embeddings with "재미"`);

    const del = await c.query(`DELETE FROM message_embeddings WHERE user_id = $1 AND content_text ILIKE '%재미%' RETURNING id`, [uid]);
    console.log(`Deleted: ${del.rowCount} embedding rows`);

    // Message에서도 사용자가 "재미"라고 family로 등록한 발화 + 그 응답 정리
    // 옛 테스트 데이터 — 현 family_member에 없는 이름이므로 안전하게 제거
    const m = await c.query(`SELECT m.id FROM "Message" m JOIN "Conversation" c ON m."conversationId" = c.id WHERE c."userId" = $1 AND m.content ILIKE '%재미%'`, [uid]);
    console.log(`\nMessage rows with "재미": ${m.rowCount} (NOT deleting — review only)`);
    for (const r of m.rows.slice(0, 5)) console.log(`  ${r.id}`);
    console.log(`  ... (총 ${m.rowCount}개. 메시지 자체는 안 지움 — 대화 흐름 보존)`);
  } finally { c.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
