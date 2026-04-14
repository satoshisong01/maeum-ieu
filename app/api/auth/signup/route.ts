import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email, password, passwordConfirm, name, age, gender, guardianName, guardianPhone, guardianRelation } = body as {
      email?: string;
      password?: string;
      passwordConfirm?: string;
      name?: string;
      age?: number;
      gender?: string;
      guardianName?: string;
      guardianPhone?: string;
      guardianRelation?: string;
    };

    if (!email || !password) {
      return NextResponse.json(
        { error: "이메일과 비밀번호를 입력해 주세요." },
        { status: 400 }
      );
    }

    if (password !== passwordConfirm) {
      return NextResponse.json(
        { error: "비밀번호가 일치하지 않습니다." },
        { status: 400 }
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "이미 사용 중인 이메일입니다." },
        { status: 400 }
      );
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        name: name ?? null,
        age: age != null && Number.isInteger(age) && age >= 0 ? age : null,
        gender: gender === "male" || gender === "female" || gender === "other" ? gender : null,
        guardianName: guardianName?.trim() || null,
        guardianPhone: guardianPhone?.trim() || null,
        guardianRelation: guardianRelation?.trim() || null,
      },
    });

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (e) {
    console.error("signup error", e);
    return NextResponse.json(
      { error: "회원가입 처리 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
