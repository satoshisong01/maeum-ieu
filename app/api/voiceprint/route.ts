/**
 * 화자 성문(voiceprint) — 등록/대조 API.
 *
 * POST { action: "enroll", embedding, dim, sampleSecs, targetUserId? }
 *   → speaker_voiceprint에 성문 저장(사용자당 1개, 갱신). 원음성은 받지 않음(벡터만).
 * POST { action: "verify", embedding, targetUserId? }
 *   → 저장된 성문과 코사인 유사도 계산 → { score, isSelf, threshold }.
 * GET  → 현재 대상의 등록 상태 { enrolled, updatedAt?, sampleSecs? }
 *
 * targetUserId(전문가/보호자가 환자 성문을 대신 등록): pro 계정 + active 연결일 때만 허용.
 * 개인정보: 대화 원문·원음성 미저장. 성문 벡터는 화자식별 목적의 생체특징정보 — 별도 동의 전제(후속).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { VOICEPRINT_MODEL_ID, VOICEPRINT_THRESHOLD, VOICEPRINT_DIM } from "@/lib/voiceprint/constants";

const EMBED_DIM = VOICEPRINT_DIM;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 대상 userId 결정 — 본인 또는 (pro+active 연결된) 환자. 아니면 null */
async function resolveTarget(session: { user: { id: string; screeningMode?: string | null } }, targetUserId?: string): Promise<string | null> {
  const self = session.user.id;
  if (!targetUserId || targetUserId === self) return self;
  if (session.user.screeningMode !== "pro") return null;
  const link = await prisma.expertPatient.findUnique({
    where: { expertUserId_patientUserId: { expertUserId: self, patientUserId: targetUserId } },
    select: { status: true },
  });
  return link?.status === "active" ? targetUserId : null;
}

function isEmbedding(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === EMBED_DIM && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const targetUserId = new URL(req.url).searchParams.get("targetUserId") || undefined;
  const uid = await resolveTarget(session, targetUserId);
  if (!uid) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  const rows = await prisma.$queryRawUnsafe<{ updated_at: Date; sample_secs: number | null; model: string }[]>(
    `SELECT updated_at, sample_secs, model FROM speaker_voiceprint WHERE user_id = $1`, uid,
  );
  const r = rows[0];
  return NextResponse.json({ enrolled: !!r, updatedAt: r?.updated_at ?? null, sampleSecs: r?.sample_secs ?? null, model: r?.model ?? null });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const rl = await checkRateLimit(`voiceprint:${session.user.id}`, 30, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body?.action;
  const uid = await resolveTarget(session as never, typeof body?.targetUserId === "string" ? body.targetUserId : undefined);
  if (!uid) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  if (!isEmbedding(body?.embedding)) {
    return NextResponse.json({ error: "임베딩 형식 오류" }, { status: 400 });
  }
  const embedding = body.embedding as number[];

  if (action === "enroll") {
    const sampleSecs = typeof body?.sampleSecs === "number" ? Math.max(0, Math.min(600, body.sampleSecs)) : null;
    await prisma.$executeRawUnsafe(
      `INSERT INTO speaker_voiceprint (user_id, embedding, dim, model, sample_secs, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, now())
       ON CONFLICT (user_id) DO UPDATE SET embedding = EXCLUDED.embedding, dim = EXCLUDED.dim,
         model = EXCLUDED.model, sample_secs = EXCLUDED.sample_secs, updated_at = now()`,
      uid, JSON.stringify(embedding), EMBED_DIM, VOICEPRINT_MODEL_ID, sampleSecs,
    );
    return NextResponse.json({ ok: true, enrolled: true });
  }

  if (action === "verify") {
    const rows = await prisma.$queryRawUnsafe<{ embedding: unknown }[]>(
      `SELECT embedding FROM speaker_voiceprint WHERE user_id = $1`, uid,
    );
    if (!rows[0]) return NextResponse.json({ error: "등록된 성문이 없습니다." }, { status: 404 });
    const stored = rows[0].embedding as number[];
    const score = cosine(embedding, stored);
    return NextResponse.json({ score, isSelf: score >= VOICEPRINT_THRESHOLD, threshold: VOICEPRINT_THRESHOLD });
  }

  return NextResponse.json({ error: "알 수 없는 action" }, { status: 400 });
}
