/**
 * Emergency notify — Webhook payload 형식 + 통합 검증 (실제 발송은 mock 서버로).
 *
 * 실제 fetch 없이 buildWebhookBody 모양만 검증하기 위해 webhook URL을 mock 엔드포인트로 설정.
 * 이 테스트는 DB·prisma·실제 서버에 의존하지 않고, 페이로드 형태 + 중복 차단 로직만 확인.
 */

// payload builder를 직접 export하지 않으므로, 모듈 구조 검증 대신
// 실제 발송 시그니처/구조를 라이브 API + DB로 통합 확인하는 접근.
import "dotenv/config";

const BASE_URL = "http://localhost:3000";
const CONV_ID = "cmni80oop000704lk3m8ayf3b";
const EMAIL = "abc@abc.com";
const PASS = "134679";

interface WebhookCapture {
  body: unknown;
  contentSnippet: string;
  level: number | null;
  category: string | null;
}

const captures: WebhookCapture[] = [];

async function startMockWebhookServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const http = await import("http");
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(raw);
          const cap: WebhookCapture = {
            body,
            contentSnippet: typeof body.content === "string" ? body.content.slice(0, 200) : "",
            level: /즉시 응급/.test(JSON.stringify(body)) ? 3 : /주의 신호/.test(JSON.stringify(body)) ? 2 : null,
            category: typeof body.embeds?.[0]?.description === "string"
              ? (body.embeds[0].description.match(/카테고리:\s*(\S+)/)?.[1] ?? null)
              : null,
          };
          captures.push(cap);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end("invalid");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function getCookie(): Promise<string> {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json() as { csrfToken: string };
  const cookies = csrfRes.headers.get("set-cookie") || "";
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    body: `csrfToken=${csrfToken}&email=${EMAIL}&password=${PASS}`,
    redirect: "manual",
  });
  const allCookies = loginRes.headers.getSetCookie?.() || [];
  return [...cookies.split(","), ...allCookies].join("; ");
}

async function setGuardianWebhook(cookie: string, url: string) {
  const r = await fetch(`${BASE_URL}/api/users/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ guardianWebhookUrl: url }),
  });
  return r.ok;
}

async function sendChat(cookie: string, msg: string) {
  const now = new Date().toISOString();
  const r = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      conversationId: CONV_ID,
      messages: [{ role: "user", content: msg, createdAt: now }],
      context: { currentTime: now, latitude: 37.2049, longitude: 127.0771 },
    }),
  });
  return r.json() as Promise<{ text?: string; emergency?: { level: number; category: string } }>;
}

async function main() {
  console.log("Starting mock webhook server...");
  const mock = await startMockWebhookServer();
  console.log("Mock webhook at", mock.url);

  let pass = 0, fail = 0;
  function assert(cond: boolean, label: string, ctx?: unknown) {
    if (cond) { console.log(`✓ ${label}`); pass++; }
    else { console.log(`✗ ${label}`); if (ctx) console.log("  ctx:", JSON.stringify(ctx)); fail++; }
  }

  try {
    const cookie = await getCookie();
    const set = await setGuardianWebhook(cookie, mock.url);
    assert(set, "보호자 webhook URL 저장 성공");

    // L3 응급 발화 발송
    captures.length = 0;
    const r1 = await sendChat(cookie, "119에 전화해줘 빨리");
    assert(r1.emergency?.level === 3, "L3 응급 감지", r1.emergency);
    // 알림은 백그라운드이므로 짧게 대기
    await new Promise((r) => setTimeout(r, 4000));
    assert(captures.length >= 1, "L3 webhook 1건 이상 수신", { captures: captures.length });
    if (captures.length > 0) {
      const c = captures[0];
      assert(/119|즉시 응급/.test(JSON.stringify(c.body)), "Payload에 응급 안내 포함");
      assert(/119에 전화해줘 빨리/.test(JSON.stringify(c.body)), "Payload에 사용자 발화 포함");
    }

    // 같은 카테고리 1시간 내 중복 차단
    captures.length = 0;
    const r2 = await sendChat(cookie, "지금 숨이 안 쉬어져 너무 힘들어");  // 같은 medical_acute
    assert(r2.emergency?.level === 3, "두 번째 L3 응급 감지", r2.emergency);
    await new Promise((r) => setTimeout(r, 4000));
    assert(captures.length === 0, "1시간 내 같은 카테고리 알림 중복 차단됨", { received: captures.length });

  } finally {
    await mock.stop();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
