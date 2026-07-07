/**
 * 전문가 검진 세션 — start(시작 기록) / end(종료 시각) / comment(의사 코멘트=환자 일지).
 * 보안: pro 계정 + ExpertPatient active 연결만. 세션 수정은 그 세션의 expert 본인만.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { CONSENT_VERSION } from "@/lib/consent";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.user.screeningMode !== "pro") return NextResponse.json({ error: "전문가 전용 기능입니다." }, { status: 403 });
  const expertId = session.user.id;
  // 검진 세션 생성·갱신 폭주(고아 세션·쓰기 DoS) 방지
  if (!(await checkRateLimit(`exam:${expertId}`, 30, 60_000)).ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "start") {
    const patientId = typeof body.patientId === "string" ? body.patientId : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    const link = await prisma.expertPatient.findUnique({
      where: { expertUserId_patientUserId: { expertUserId: expertId, patientUserId: patientId } },
      select: { status: true },
    });
    if (!link || link.status !== "active") return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });
    // 일반인(general) 계정은 인지검진 비대상 — 인지 데이터가 잘못된 계정에 기록되지 않도록 차단(목적 분리)
    const patient = await prisma.user.findUnique({ where: { id: patientId }, select: { screeningMode: true } });
    if (patient?.screeningMode === "general") return NextResponse.json({ error: "일반인 계정은 인지검진 대상이 아닙니다." }, { status: 400 });
    // 진행 중이던 기존 세션 자동 종료 — 고아 세션 누적 방지(다중 클릭·중간 재시작).
    //   ⚠ ended_at은 검진 상한(시작+30분)으로 캡(2026-07-07 감사 blocker): now()로 찍으면 며칠 전 고아 세션의
    //   문답 창이 [이전 검진~현재]로 확장돼 그 사이 일상 대화 원문이 전문가 화면 '문답 기록'에 노출됨.
    await prisma.$executeRawUnsafe(
      `UPDATE exam_session SET ended_at = LEAST(now(), started_at + interval '30 minutes') WHERE expert_user_id = $1 AND patient_user_id = $2 AND ended_at IS NULL`,
      expertId, patientId).catch(() => {});
    const id = randomUUID();
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO exam_session (id, patient_user_id, expert_user_id, conversation_id) VALUES ($1, $2, $3, $4)`,
        id, patientId, expertId, conversationId,
      );
      // 환자 검진 동의(건강 민감정보 + 전문가 제공) 기록 — 환자가 동의 화면에서 체크+성함 서명한 경우.
      //   감사 증빙(expert_access_log) + 미동의였다면 정식 건강정보 동의(consentedAt)도 이때 성립.
      if (body.patientConsent === true) {
        prisma.$executeRawUnsafe(
          `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, $3, $4)`,
          `eal_${randomUUID()}`, expertId, patientId, "exam_consent",
        ).catch(() => {});
        await prisma.user.updateMany({ where: { id: patientId, consentedAt: null }, data: { consentedAt: new Date(), consentVersion: CONSENT_VERSION } }).catch(() => {});
      }
      return NextResponse.json({ sessionId: id });
    } catch {
      // 동시 시작 경합(부분 unique uq_es_open 위반) — 이미 열린 세션을 반환(고아·중복 방지)
      const open = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM exam_session WHERE expert_user_id = $1 AND patient_user_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        expertId, patientId);
      if (open[0]) return NextResponse.json({ sessionId: open[0].id });
      return NextResponse.json({ error: "검진 시작에 실패했습니다." }, { status: 500 });
    }
  }

  if (action === "end" || action === "comment" || action === "evalInput") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    // 본인 세션만 수정 + 현재도 활성 연결인지 재확인(동의 철회 후 쓰기 차단)
    const rows = await prisma.$queryRawUnsafe<{ id: string; patient_user_id: string }[]>(
      `SELECT id, patient_user_id FROM exam_session WHERE id = $1 AND expert_user_id = $2`, sessionId, expertId);
    if (rows.length === 0) return NextResponse.json({ error: "세션을 찾을 수 없습니다." }, { status: 404 });
    const link = await prisma.expertPatient.findUnique({
      where: { expertUserId_patientUserId: { expertUserId: expertId, patientUserId: rows[0].patient_user_id } },
      select: { status: true },
    });
    if (!link || link.status !== "active") return NextResponse.json({ error: "연결이 해지된 환자입니다." }, { status: 403 });
    if (action === "end") {
      await prisma.$executeRawUnsafe(`UPDATE exam_session SET ended_at = now() WHERE id = $1`, sessionId);
    } else if (action === "comment") {
      const comment = typeof body.comment === "string" ? body.comment.slice(0, 4000) : "";
      await prisma.$executeRawUnsafe(`UPDATE exam_session SET doctor_comment = $2 WHERE id = $1`, sessionId, comment);
    } else {
      // evalInput — 의사 보정: 학력(년)·시공간(시계 0~2). null이면 미입력으로 둠.
      const edu = body.educationYears === null || body.educationYears === "" ? null
        : Math.max(0, Math.min(30, Math.round(Number(body.educationYears))));
      const vs = body.visuospatialScore === null || body.visuospatialScore === "" ? null
        : Math.max(0, Math.min(2, Math.round(Number(body.visuospatialScore))));
      const eduVal = Number.isFinite(edu as number) ? edu : null;
      const vsVal = Number.isFinite(vs as number) ? vs : null;
      await prisma.$executeRawUnsafe(`UPDATE exam_session SET education_years = $2, visuospatial_score = $3 WHERE id = $1`, sessionId, eduVal, vsVal);
    }
    // 변경 이력(규제 대비) — 누가 언제 어떤 검진 쓰기를 했는지. 실패 무시.
    prisma.$executeRawUnsafe(
      `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, $3, $4)`,
      `eal_${Date.now()}_${expertId.slice(0, 8)}`, expertId, rows[0].patient_user_id, `exam_${action}`,
    ).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
}
