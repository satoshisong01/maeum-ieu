import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { normalizeTimes } from "@/lib/chat/medication";
import { checkRateLimit } from "@/lib/rate-limit";

interface MedicationDraftInput { label?: string; times?: unknown; enabled?: boolean }

export async function POST(req: Request) {
  try {
    // 미인증 엔드포인트 — IP 기준 가입 폭주/봇 방어 (분당 10회)
    const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
    const rl = checkRateLimit(`signup:${ip}`, 10, 60_000);
    if (!rl.ok) {
      return NextResponse.json({ error: "잠시 후 다시 시도해 주세요." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
    }

    const body = await req.json();
    const { email, password, passwordConfirm, name, age, gender, guardianName, guardianPhone, guardianRelation, companionName, companionRelation, userHonorific, screeningMode, medicationDrafts } = body as {
      email?: string;
      password?: string;
      passwordConfirm?: string;
      name?: string;
      age?: number;
      gender?: string;
      guardianName?: string;
      guardianPhone?: string;
      guardianRelation?: string;
      companionName?: string;
      companionRelation?: string;
      userHonorific?: string;
      screeningMode?: string;
      medicationDrafts?: MedicationDraftInput[];
    };

    if (!email || !password) {
      return NextResponse.json(
        { error: "이메일과 비밀번호를 입력해 주세요." },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "비밀번호는 8자 이상이어야 합니다." },
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
        companionName: companionName?.trim() || undefined,
        companionRelation: companionRelation?.trim() || undefined,
        userHonorific: userHonorific?.trim() || null,
        screeningMode: screeningMode === "pro" ? "pro" : "user", // 계정 역할(가입 시 선택)
      },
    });

    // 복약 스케줄 초기 등록 — 회원가입 시 입력한 경우만
    if (Array.isArray(medicationDrafts) && medicationDrafts.length > 0) {
      const valid = medicationDrafts
        .map((d) => ({
          label: typeof d?.label === "string" ? d.label.trim().slice(0, 40) : "",
          times: normalizeTimes(d?.times),
          enabled: d?.enabled !== false,
        }))
        .filter((d) => d.label && d.times.length > 0);
      if (valid.length > 0) {
        await prisma.medicationSchedule.createMany({
          data: valid.map((d) => ({
            userId: user.id, label: d.label, times: d.times, enabled: d.enabled,
          })),
        });
      }
    }

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
