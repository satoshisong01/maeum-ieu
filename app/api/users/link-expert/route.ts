/**
 * 환자 → 전문가 연결 — POST { code }: 전문가 초대 코드를 입력해 ExpertPatient(active) 생성.
 * 환자 본인이 입력하는 구조 = 본인 동의. 전문가는 이후 채점·요약만 열람(대화 원문 비공개).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  // 코드 무차별 대입 방지 — 계정당 분당 10회
  const rl = checkRateLimit(`link-expert:${session.user.id}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  let code = "";
  try {
    const body = await req.json();
    code = String(body?.code ?? "").trim().toUpperCase();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }
  if (!/^[A-Z0-9]{6,12}$/.test(code)) {
    return NextResponse.json({ error: "코드 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const expert = await prisma.user.findUnique({
    where: { expertCode: code },
    select: { id: true, name: true, screeningMode: true },
  });
  if (!expert || expert.screeningMode !== "pro") {
    return NextResponse.json({ error: "유효하지 않은 전문가 코드입니다." }, { status: 404 });
  }
  if (expert.id === session.user.id) {
    return NextResponse.json({ error: "본인 계정에는 연결할 수 없습니다." }, { status: 400 });
  }

  await prisma.expertPatient.upsert({
    where: { expertUserId_patientUserId: { expertUserId: expert.id, patientUserId: session.user.id } },
    create: { expertUserId: expert.id, patientUserId: session.user.id, status: "active" },
    update: { status: "active" },
  });

  console.log("[expert-link] created", JSON.stringify({ expert: expert.id.slice(0, 8), patient: session.user.id.slice(0, 8) }));
  return NextResponse.json({ ok: true, expertName: expert.name ?? "전문가" });
}
