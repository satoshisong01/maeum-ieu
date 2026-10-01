/**
 * 구독 권리 판정 라이브 검증 — 실제 DB에 구독 레코드를 넣어 혜택이 올바르게 적용·회수되는지 확인.
 *
 * 왜 스크립트인가: 단위 테스트는 prisma를 스텁하므로 **실제 스키마·인덱스·쿼리**가
 *   맞는지 증명하지 못한다. 돈이 걸린 판정이라 실제 DB에서 한 번은 돌려봐야 한다.
 *
 * 안전: 전용 토큰(__billing_verify_script__)만 쓰고 끝나면 지운다.
 *   Play Developer API는 호출하지 않는다(실제 구매 없이 검증 불가).
 *
 * 사용: npx tsx scripts/billing-verify.ts
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { getEntitlement, resolveBeneficiary } from "../lib/billing/entitlement";
import { getDailyUsage, DAILY_TURN_LIMIT } from "../lib/usage/daily-limit";
import { isPlayConfigured, mapState } from "../lib/billing/play-api";
import { BILLING_ENFORCE, PRO_PRODUCT_IDS, ENTITLED_STATUSES } from "../lib/billing/plans";

const TOKEN = "__billing_verify_script__";
const ELDER = "convtest@maeum.test";
const GUARDIAN = "notifytest.guardian@maeum.test";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ FAILED ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  console.log("## 설정");
  console.log(`  무료 일일 상한: ${DAILY_TURN_LIMIT}`);
  console.log(`  유료 상품 ID  : ${PRO_PRODUCT_IDS.length ? PRO_PRODUCT_IDS.join(", ") : "(미지정 — 모든 상품 인정)"}`);
  console.log(`  결제 강제     : ${BILLING_ENFORCE ? "ON" : "off (기본)"}`);
  console.log(`  Play 검증 설정: ${isPlayConfigured() ? "완료" : "미설정 — verify 엔드포인트는 503"}`);

  const elder = await prisma.user.findUnique({ where: { email: ELDER }, select: { id: true } });
  const guardian = await prisma.user.findUnique({ where: { email: GUARDIAN }, select: { id: true } });
  if (!elder || !guardian) {
    console.log(`\n테스트 계정 없음(${ELDER} / ${GUARDIAN}) — 건너뜁니다.`);
    return;
  }

  console.log("\n## 구독 전");
  check("어르신 무료", (await getEntitlement(elder.id)).tier === "free");
  check("보호자 무료", (await getEntitlement(guardian.id)).tier === "free");

  await prisma.subscription.deleteMany({ where: { purchaseToken: TOKEN } });
  await prisma.subscription.create({
    data: {
      purchaserUserId: guardian.id, beneficiaryUserId: elder.id,
      productId: PRO_PRODUCT_IDS[0] ?? "maeum_monthly_test", purchaseToken: TOKEN,
      status: "active", expiresAt: new Date(Date.now() + 30 * 86400_000),
    },
  });

  try {
    console.log("\n## 보호자 결제 → 어르신 적용");
    const e = await getEntitlement(elder.id);
    const g = await getEntitlement(guardian.id);
    check("어르신 유료 전환", e.tier === "pro", `source=${e.source} limit=${e.dailyTurnLimit}`);
    check("어르신은 혜택 대상", e.source === "beneficiary");
    check("상한이 올라감", e.dailyTurnLimit > DAILY_TURN_LIMIT, `${DAILY_TURN_LIMIT} → ${e.dailyTurnLimit}`);
    check("보호자도 유료", g.tier === "pro", `source=${g.source}`);
    check("보호자는 결제자", g.source === "purchaser");
    check("보호자 기능 열림", g.guardianFeatures);

    const conv = await prisma.conversation.findFirst({
      where: { userId: elder.id }, orderBy: { createdAt: "desc" }, select: { id: true },
    });
    if (conv) {
      const u = await getDailyUsage(conv.id, elder.id);
      console.log(`  사용량: used=${u.used} limit=${u.limit} exceeded=${u.exceeded}`);
      check("일일 상한에 구독이 반영됨", u.limit >= DAILY_TURN_LIMIT);
    }

    console.log("\n## 상태 변화");
    for (const st of ["grace", "canceled"]) {
      await prisma.subscription.update({ where: { purchaseToken: TOKEN }, data: { status: st } });
      check(`${st} 상태는 혜택 유지`, (await getEntitlement(elder.id)).tier === "pro");
    }
    for (const st of ["on_hold", "paused", "expired", "pending"]) {
      await prisma.subscription.update({ where: { purchaseToken: TOKEN }, data: { status: st } });
      check(`${st} 상태는 혜택 종료`, (await getEntitlement(elder.id)).tier === "free");
    }

    console.log("\n## 만료·환불");
    await prisma.subscription.update({
      where: { purchaseToken: TOKEN },
      data: { status: "active", expiresAt: new Date(Date.now() - 1000), revokedAt: null },
    });
    check("만료 시각이 지나면 무료 — RTDN 지연 대비", (await getEntitlement(elder.id)).tier === "free");

    await prisma.subscription.update({
      where: { purchaseToken: TOKEN },
      data: { status: "revoked", revokedAt: new Date(), expiresAt: new Date(Date.now() + 86400_000) },
    });
    check("환불·무효화는 즉시 차단", (await getEntitlement(elder.id)).tier === "free");

    console.log("\n## 혜택 대상 결정");
    // 보호자 계정이 어느 어르신과 연결돼 있는지는 환경마다 다르다(이 보호자는 notifytest 어르신과
    //   연결됨). 특정 계정을 기대하지 말고 '실제 active 링크인지'를 검증한다.
    const resolved = await resolveBeneficiary(guardian.id);
    const link = resolved === guardian.id ? null : await prisma.expertPatient.findUnique({
      where: { expertUserId_patientUserId: { expertUserId: guardian.id, patientUserId: resolved } },
      select: { status: true },
    });
    check("연결된 어르신이 대상", link?.status === "active" || resolved === guardian.id,
      resolved === guardian.id ? "연결 없음 → 결제자 본인" : `${resolved.slice(0, 8)} (active 링크)`);
    const bogus = await resolveBeneficiary(guardian.id, "nonexistent-user-id");
    check("미연결 대상 요청은 무시", bogus !== "nonexistent-user-id", `${bogus.slice(0, 8)}`);

    console.log("\n## Play 상태 매핑");
    const cases: [string, boolean, boolean][] = [
      ["SUBSCRIPTION_STATE_ACTIVE", true, true],
      ["SUBSCRIPTION_STATE_ACTIVE", false, true],   // 해지 예약 — 만료일까지 유지
      ["SUBSCRIPTION_STATE_IN_GRACE_PERIOD", true, true],
      ["SUBSCRIPTION_STATE_ON_HOLD", true, false],
      ["SUBSCRIPTION_STATE_EXPIRED", false, false],
      ["SUBSCRIPTION_STATE_PENDING", true, false],
    ];
    for (const [state, autoRenew, entitled] of cases) {
      const mapped = mapState(state, autoRenew);
      check(`${state.replace("SUBSCRIPTION_STATE_", "")}(renew=${autoRenew}) → ${mapped}`,
        ENTITLED_STATUSES.includes(mapped) === entitled);
    }
  } finally {
    await prisma.subscription.deleteMany({ where: { purchaseToken: TOKEN } });
    const left = await prisma.subscription.count({ where: { purchaseToken: TOKEN } });
    console.log(`\n정리: 테스트 구독 ${left}건 남음 (0이어야 정상)`);
  }

  console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ""}`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("실패:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
