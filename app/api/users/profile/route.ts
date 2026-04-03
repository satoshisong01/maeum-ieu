import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

/** GET: 현재 사용자 프로필 조회 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, age: true, gender: true, createdAt: true },
  });

  if (!user) {
    return NextResponse.json({ error: "사용자를 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json(user);
}

/** PATCH: 프로필 수정 */
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const body = await req.json();
  const { name, age, gender, currentPassword, newPassword } = body as {
    name?: string;
    age?: number | null;
    gender?: string | null;
    currentPassword?: string;
    newPassword?: string;
  };

  // 비밀번호 변경 요청 시 검증
  if (newPassword) {
    if (!currentPassword) {
      return NextResponse.json({ error: "현재 비밀번호를 입력해주세요." }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: "새 비밀번호는 최소 6자 이상이어야 합니다." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { password: true },
    });

    if (!user?.password) {
      return NextResponse.json({ error: "비밀번호를 확인할 수 없습니다." }, { status: 400 });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return NextResponse.json({ error: "현재 비밀번호가 일치하지 않습니다." }, { status: 400 });
    }
  }

  // gender 유효성 검사
  const validGenders = ["male", "female", "other"];
  if (gender !== undefined && gender !== null && !validGenders.includes(gender)) {
    return NextResponse.json({ error: "올바른 성별을 선택해주세요." }, { status: 400 });
  }

  // age 유효성 검사
  if (age !== undefined && age !== null && (age < 1 || age > 120 || !Number.isInteger(age))) {
    return NextResponse.json({ error: "나이는 1~120 사이의 정수여야 합니다." }, { status: 400 });
  }

  // 업데이트 데이터 구성
  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name || null;
  if (age !== undefined) updateData.age = age;
  if (gender !== undefined) updateData.gender = gender;
  if (newPassword) updateData.password = await bcrypt.hash(newPassword, 10);

  const updated = await prisma.user.update({
    where: { id: session.user.id },
    data: updateData,
    select: { id: true, name: true, email: true, age: true, gender: true },
  });

  return NextResponse.json(updated);
}
