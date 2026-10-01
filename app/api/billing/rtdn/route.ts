/**
 * RTDN(Real-time Developer Notifications) 수신 — Play가 Pub/Sub으로 밀어주는 구독 변경 통지.
 *
 * 왜 필요한가: 갱신·해지·환불·결제 보류는 앱을 켜지 않아도 일어난다. 통지를 받지 않으면
 *   해지한 사람이 계속 유료 혜택을 받거나(비용), 갱신된 사람이 무료로 떨어진다(불만).
 *
 * 신뢰 모델: **통지 내용을 그대로 믿지 않는다.** 통지는 "이 토큰을 다시 확인해보라"는
 *   신호로만 쓰고, 상태는 Play Developer API에 직접 물어 기록한다(위조 통지 무효화).
 *
 * 인증: Pub/Sub push는 쿼리 공유 비밀(?secret=) 또는 OIDC 토큰으로 보호한다.
 *   여기서는 공유 비밀을 쓴다 — Pub/Sub 구독의 push endpoint에 쿼리로 넣어두면 된다.
 *   BILLING_RTDN_SECRET 미설정 시 엔드포인트는 404처럼 동작한다(열린 채로 두지 않는다).
 *
 * 응답 규칙: Pub/Sub은 비200이면 재시도한다. 우리가 처리할 수 없는 통지(모르는 토큰 등)는
 *   200으로 삼켜 무한 재시도를 막고, 일시적 오류만 500으로 재시도를 유도한다.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSubscription, mapState, isPlayConfigured } from "@/lib/billing/play-api";
import { timingSafeEqual } from "node:crypto";

const mask = (t: string) => `${t.slice(0, 6)}…${t.slice(-4)}`;

function secretOk(req: Request): boolean {
  const expected = process.env.BILLING_RTDN_SECRET?.trim();
  if (!expected) return false;
  const got = new URL(req.url).searchParams.get("secret") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface RtdnPayload {
  subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string };
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string };
  testNotification?: { version?: string };
  packageName?: string;
}

export async function POST(req: Request) {
  if (!secretOk(req)) {
    // 비밀 미설정·불일치 — 존재를 알리지 않는다
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const envelope = await req.json().catch(() => null) as { message?: { data?: string; messageId?: string } } | null;
  const dataB64 = envelope?.message?.data;
  if (!dataB64) {
    // 형식이 다른 요청은 재시도해도 소용없다 — 200으로 종료
    return NextResponse.json({ ok: true, skipped: "no-data" });
  }

  let payload: RtdnPayload;
  try {
    payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf-8")) as RtdnPayload;
  } catch {
    return NextResponse.json({ ok: true, skipped: "bad-json" });
  }

  if (payload.testNotification) {
    console.log("[rtdn] 테스트 통지 수신 — 연결 정상");
    return NextResponse.json({ ok: true, test: true });
  }

  // 환불·구매 무효화는 즉시 권리를 끊는다(Play 재확인 없이도 안전한 방향)
  const voidedToken = payload.voidedPurchaseNotification?.purchaseToken;
  if (voidedToken) {
    const r = await prisma.subscription.updateMany({
      where: { purchaseToken: voidedToken },
      data: { status: "revoked", revokedAt: new Date(), verifiedAt: new Date() },
    });
    console.log(`[rtdn] 환불·무효화 반영 token=${mask(voidedToken)} rows=${r.count}`);
    return NextResponse.json({ ok: true, voided: r.count });
  }

  const token = payload.subscriptionNotification?.purchaseToken;
  if (!token) return NextResponse.json({ ok: true, skipped: "no-token" });

  const known = await prisma.subscription.findUnique({ where: { purchaseToken: token }, select: { id: true } });
  if (!known) {
    // 아직 검증 전(앱이 verify를 호출하기 전에 통지가 먼저 올 수 있다) — 재시도해도
    //   우리가 결제자를 알 수 없으므로 삼킨다. 앱이 verify를 호출하면 최신 상태로 기록된다.
    console.log(`[rtdn] 미등록 토큰 — 무시 token=${mask(token)} type=${payload.subscriptionNotification?.notificationType}`);
    return NextResponse.json({ ok: true, skipped: "unknown-token" });
  }

  if (!isPlayConfigured()) {
    console.error("[rtdn] Play 검증 미설정 — 상태 갱신 불가");
    return NextResponse.json({ error: "not configured" }, { status: 500 }); // 설정 후 재시도되게
  }

  try {
    const sub = await getSubscription(token);
    await prisma.subscription.update({
      where: { purchaseToken: token },
      data: {
        status: mapState(sub.state, sub.autoRenewing),
        expiresAt: sub.expiresAt,
        verifiedAt: new Date(),
        ...(sub.productId ? { productId: sub.productId } : {}),
      },
    });
    console.log(`[rtdn] 상태 갱신 token=${mask(token)} state=${sub.state} → ${mapState(sub.state, sub.autoRenewing)}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // 일시적 오류 — Pub/Sub 재시도에 맡긴다
    console.warn(`[rtdn] 재확인 실패 token=${mask(token)}:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}
