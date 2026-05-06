/**
 * "AI가 제시한 단어"의 첫글자가 (직전 사용자 단어 끝글자가 아닌)
 * "직전 단어 첫글자"를 시작글자로 요청한 케이스를 모든 대화에서 검출.
 */
import "dotenv/config";
const { Pool } = require("pg");

const STARTS_PATTERN = /'([가-힣])'(?:로|으로)\s*시작하는\s*단어/;
const AI_PROPOSED = /(?:민지가|이번엔|이번에).*?'([가-힣]{1,5})'(?:이?라고|라고)/;

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode","no-verify"); connStr = u.toString(); } catch {}
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const r = await c.query(`
      SELECT id, "conversationId", role, content, "createdAt"
      FROM "Message"
      WHERE role='assistant' AND content ~ '시작하는 단어'
      ORDER BY "createdAt" ASC
    `);
    let total = 0, bug = 0;
    const bugs: Array<{ ts: string; conv: string; ai: string; asked: string; expected: string; raw: string }> = [];
    for (const m of r.rows) {
      const proposed = m.content.match(AI_PROPOSED);
      const asked = m.content.match(STARTS_PATTERN);
      if (!proposed || !asked) continue;
      total++;
      const aiWord = proposed[1];
      const lastChar = aiWord[aiWord.length - 1];
      const askedStart = asked[1];
      if (askedStart !== lastChar) {
        bug++;
        bugs.push({
          ts: new Date(m.createdAt).toISOString().slice(0, 19),
          conv: m.conversationId.slice(0, 16),
          ai: aiWord,
          asked: askedStart,
          expected: lastChar,
          raw: m.content.slice(0, 160),
        });
      }
    }
    console.log(`전체 끝말잇기 AI 제시: ${total}건, 버그(시작글자 오지시): ${bug}건\n`);
    for (const b of bugs.slice(0, 30)) {
      console.log(`❌ ${b.ts} ${b.conv}  AI="${b.ai}" → 요청 '${b.asked}' (정답 '${b.expected}')`);
      console.log(`   "${b.raw}"\n`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
