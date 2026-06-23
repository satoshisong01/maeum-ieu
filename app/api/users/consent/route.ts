/** 건강정보 수집·이용 동의 기록. POST=동의(시각·버전 저장). */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CONSENT_VERSION } from "@/lib/consent";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { consentedAt: new Date(), consentVersion: CONSENT_VERSION },
  });
  return NextResponse.json({ ok: true });
}
