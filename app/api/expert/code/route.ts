/**
 * 전문가 초대 코드 — GET: 내 코드 조회(없으면 생성). pro 계정 전용.
 * 환자가 마이페이지에서 이 코드를 입력하면 ExpertPatient 연결이 생성된다(환자 본인 동의 방식).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { randomBytes } from "crypto";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// 혼동 문자(0/O, 1/I/L) 제외 — 어르신 보호자가 입력하기 쉬운 코드
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode(): string {
  const buf = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.user.screeningMode !== "pro") {
    return NextResponse.json({ error: "전문가 계정 전용 기능입니다." }, { status: 403 });
  }

  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { expertCode: true } });
  if (me?.expertCode) return NextResponse.json({ code: me.expertCode });

  // 생성 — unique 충돌 시 재시도 (31^8 공간이라 사실상 무충돌)
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      await prisma.user.update({ where: { id: session.user.id }, data: { expertCode: code } });
      return NextResponse.json({ code });
    } catch {
      // unique 충돌 — 재시도
    }
  }
  return NextResponse.json({ error: "코드 생성에 실패했습니다. 다시 시도해주세요." }, { status: 500 });
}
