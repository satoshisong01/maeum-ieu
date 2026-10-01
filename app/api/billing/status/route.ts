/**
 * 내 구독 상태 조회 — 앱·웹이 유료 여부와 남은 대화량을 표시할 때 쓴다.
 *
 * 민감정보(구매 토큰·주문 ID)는 돌려주지 않는다. 화면에 필요한 것만 — 티어, 만료일,
 *   오늘 남은 대화 수, 혜택 대상(보호자가 결제한 경우 어르신 이름).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEntitlement } from "@/lib/billing/entitlement";
import { getDailyUsage } from "@/lib/usage/daily-limit";
import { BILLING_ENFORCE, PRO_PRODUCT_IDS } from "@/lib/billing/plans";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const userId = session.user.id;

  const ent = await getEntitlement(userId);

  // 어르신 본인 계정이면 오늘 사용량도 함께 — 보호자 화면에는 자기 대화량이 의미 없다
  let usage: { used: number; limit: number; remaining: number } | null = null;
  if (session.user.screeningMode !== "pro" && session.user.screeningMode !== "guardian") {
    const conv = await prisma.conversation.findFirst({
      where: { userId }, orderBy: { createdAt: "desc" }, select: { id: true },
    });
    if (conv) {
      const u = await getDailyUsage(conv.id, userId);
      usage = { used: u.used, limit: u.limit, remaining: u.remaining };
    }
  }

  // 보호자가 결제한 경우 누구에게 혜택이 가는지 보여준다(결제 후 "적용이 됐나?" 불안 해소)
  let beneficiaryName: string | null = null;
  if (ent.tier === "pro") {
    const sub = await prisma.subscription.findFirst({
      where: { purchaserUserId: userId, revokedAt: null },
      orderBy: { expiresAt: "desc" },
      select: { beneficiary: { select: { id: true, name: true } } },
    });
    if (sub?.beneficiary && sub.beneficiary.id !== userId) beneficiaryName = sub.beneficiary.name ?? null;
  }

  return NextResponse.json({
    tier: ent.tier,
    expiresAt: ent.expiresAt?.toISOString() ?? null,
    source: ent.source,
    guardianFeatures: ent.guardianFeatures,
    beneficiaryName,
    usage,
    // 앱이 구매 시트를 띄울 때 쓸 상품 ID. 비어 있으면 아직 가격이 정해지지 않은 상태다.
    productIds: PRO_PRODUCT_IDS,
    enforced: BILLING_ENFORCE,
  });
}
