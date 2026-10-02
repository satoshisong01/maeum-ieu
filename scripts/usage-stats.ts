/**
 * 실제 사용량 분포 조사 — 일일 상한을 얼마로 둘지 판단하기 위한 근거.
 *
 * 테스트 계정과 실사용 계정을 분리한다. 이 구분을 안 하면 내가 만든 검증 트래픽이
 *   '실사용자 분포'로 집계돼 상한 결정을 완전히 잘못 이끈다.
 *
 * PII 보호: 이메일·이름은 출력하지 않는다(해시 앞 6자만).
 * 사용: npx tsx scripts/usage-stats.ts
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { createHash } from "node:crypto";
import { isTestAccount } from "../lib/test-accounts";

/**
 * ⚠ 결함(2026-10-02 발견·수정): 이 목록만으로는 **테스트 계정의 92%를 놓쳤다.**
 *   scripts/e2e-roles.mjs가 만드는 계정은 `role_<role>_<ts>@example.com` 형태인데
 *   여기엔 `@example.com` 패턴이 없어 전부 '실사용자'로 집계됐다.
 *   실측: 317계정 중 287개가 @example.com인데 이 목록은 24개만 테스트로 분류 — 285개 불일치.
 *   그 결과 "실사용 5140건 / 테스트 1575건(23%)"이라는 **정반대 결론**이 나왔고,
 *   그 숫자가 일일 상한·가격 결정의 근거로 쓰였다. 측정이 거짓이면 그 위 판단이 전부 거짓이다.
 *
 * 수정: lib/test-accounts.ts(RFC 2606/6761 예약 도메인)와 **합집합**으로 판정한다.
 *
 * ⚠ 두 모듈의 기준이 다른 것은 **의도적**이며, 방향이 반대라서 그렇다:
 *   · lib/test-accounts.ts (응급 워치독용) — 보수적. 실사용자를 테스트로 오분류하면
 *     그 어르신의 응급이 감시에서 조용히 빠진다. 그래서 예약 도메인만 본다.
 *   · 여기(통계용) — 공격적. 테스트를 실사용자로 세면 사용량을 과대평가해
 *     상한·가격을 잘못 정한다. 그래서 합집합으로 더 많이 걸러낸다.
 *   이 주석이 사라지면 누군가 "일관성"을 이유로 하나로 합칠 텐데, 그러면 둘 중 하나가 틀려진다.
 */
const TEST_PATTERNS = [
  /@maeum\.test$/i, /@test\.com$/i, /^test/i, /^convtest/i, /^modeltest/i,
  /^notifytest/i, /^abc/i, /^rudtjrch/i, /demo/i, /^qa/i, /playwright/i,
  /^role_/i,                 // e2e-roles.mjs 자동 생성 계정
  /@(maeum\.app|maeum\.kr|firstcorea\.com|admin\.com)$/i,  // 사내·운영 계정(실사용자 아님)
];
export const isTest = (email: string) => isTestAccount(email) || TEST_PATTERNS.some((p) => p.test(email));
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, screeningMode: true, createdAt: true,
      conversations: { select: { id: true } } },
  });

  const real = users.filter((u) => !isTest(u.email));
  const test = users.filter((u) => isTest(u.email));
  console.log(`## 계정\n  전체 ${users.length} · 실사용 후보 ${real.length} · 테스트 ${test.length}`);
  const byMode = real.reduce<Record<string, number>>((a, u) => { a[u.screeningMode] = (a[u.screeningMode] ?? 0) + 1; return a; }, {});
  console.log(`  실사용 역할별: ${Object.entries(byMode).map(([k, v]) => `${k}=${v}`).join(" · ")}`);

  // KST 날짜별 사용자 발화 수 (대화 소유자 기준)
  const rows = await prisma.$queryRawUnsafe<{ user_id: string; d: string; n: bigint }[]>(`
    SELECT c."userId" AS user_id,
           to_char(m."createdAt" + interval '9 hours', 'YYYY-MM-DD') AS d,
           COUNT(*) AS n
      FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
     WHERE m.role = 'user'
     GROUP BY 1, 2`);

  const realIds = new Set(real.map((u) => u.id));
  const emailOf = new Map(users.map((u) => [u.id, u.email]));
  const modeOf = new Map(users.map((u) => [u.id, u.screeningMode]));

  const realRows = rows.filter((r) => realIds.has(r.user_id));
  const testRows = rows.filter((r) => !realIds.has(r.user_id));
  const sum = (rs: typeof rows) => rs.reduce((a, r) => a + Number(r.n), 0);

  console.log(`\n## 전체 발화량 (role=user)`);
  console.log(`  실사용 ${sum(realRows)}건 / 테스트 ${sum(testRows)}건  → 테스트가 전체의 ${Math.round(sum(testRows) / (sum(realRows) + sum(testRows)) * 100)}%`);

  if (realRows.length === 0) { console.log("\n실사용 발화 없음 — 분포 분석 불가"); return; }

  // 1) '활동일'의 일일 발화 분포 (0턴인 날은 제외 — 쓴 날에 얼마나 쓰는지)
  const daily = realRows.map((r) => Number(r.n)).sort((a, b) => a - b);
  console.log(`\n## 활동일 기준 일일 발화 분포 (n=${daily.length} 사용자-일)`);
  console.log(`  중앙값 ${pct(daily, 50)} · p75 ${pct(daily, 75)} · p90 ${pct(daily, 90)} · p95 ${pct(daily, 95)} · 최대 ${daily[daily.length - 1]}`);
  for (const cap of [10, 20, 30, 50, 100]) {
    const over = daily.filter((n) => n > cap).length;
    console.log(`  상한 ${String(cap).padStart(3)}턴 → 걸리는 날 ${over}/${daily.length} (${(over / daily.length * 100).toFixed(1)}%)`);
  }

  // 2) 사용자별 집계
  const perUser = new Map<string, { days: number; total: number; max: number }>();
  for (const r of realRows) {
    const cur = perUser.get(r.user_id) ?? { days: 0, total: 0, max: 0 };
    cur.days++; cur.total += Number(r.n); cur.max = Math.max(cur.max, Number(r.n));
    perUser.set(r.user_id, cur);
  }
  console.log(`\n## 사용자별 (발화가 1건 이상인 실사용 계정 ${perUser.size}명)`);
  const ranked = [...perUser.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log("  해시   역할      활동일  총발화  하루최대  일평균");
  for (const [id, s] of ranked.slice(0, 15)) {
    console.log(`  ${h(emailOf.get(id) ?? id)}  ${(modeOf.get(id) ?? "?").padEnd(8)}  ${String(s.days).padStart(5)}  ${String(s.total).padStart(6)}  ${String(s.max).padStart(7)}  ${(s.total / s.days).toFixed(1)}`);
  }
  if (ranked.length > 15) console.log(`  … 외 ${ranked.length - 15}명`);

  // 3) 기간
  const dates = realRows.map((r) => r.d).sort();
  console.log(`\n## 기간: ${dates[0]} ~ ${dates[dates.length - 1]}`);

  // 4) 상한을 넘긴 적 있는 사용자
  const heavy = ranked.filter(([, s]) => s.max > 20);
  console.log(`\n## 하루 20턴을 넘긴 적 있는 실사용자: ${heavy.length}명 / ${perUser.size}명`);
  for (const [id, s] of heavy) console.log(`  ${h(emailOf.get(id) ?? id)} 최대 ${s.max}턴 (${modeOf.get(id)})`);
}

main().catch((e) => { console.error("실패:", e); process.exit(1); }).finally(() => prisma.$disconnect());
