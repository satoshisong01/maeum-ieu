import pg from "pg"; import "dotenv/config";
let cs = process.env.DATABASE_URL;
try { const u = new URL(cs); u.searchParams.set("sslmode", "no-verify"); cs = u.toString(); } catch {}
const p = new pg.Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
const c = await p.connect();
const u = await c.query(`SELECT id FROM "User" WHERE email='cycle_test_2026@example.com'`);
const r = await c.query(
  `SELECT role, LEFT(content,90) AS content, "createdAt" FROM "Message"
   WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1)
   ORDER BY "createdAt" DESC LIMIT 6`, [u.rows[0].id]);
for (const x of r.rows.reverse()) console.log(`[${new Date(x.createdAt).toLocaleTimeString("ko-KR")}] ${x.role}: ${x.content}`);
c.release(); await p.end();
