/**
 * 화자 성문(voiceprint) — 표본 누적 등록 / 대조 API.
 *
 * POST { action: "enroll", embedding, sampleSecs, targetUserId? }
 *   → 개별 표본(speaker_voiceprint_sample)에 추가 + 전체 표본 평균으로 대표 성문(speaker_voiceprint) 갱신.
 *     지문 다회 등록처럼 표본이 쌓일수록 대표 성문이 안정화됨. 원음성 미저장(벡터만).
 * POST { action: "verify", embedding, targetUserId? }  → 대표 성문과 코사인 유사도 → { score, isSelf }
 * POST { action: "reset",  targetUserId? }              → 표본·대표 성문 전부 삭제(다시 처음부터)
 * GET  → { enrolled, sampleCount, updatedAt?, sampleSecs? }
 *
 * targetUserId(보호자가 환자 대신 등록): pro + active 연결일 때만.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { VOICEPRINT_MODEL_ID, VOICEPRINT_THRESHOLD, VOICEPRINT_DIM } from "@/lib/voiceprint/constants";

const EMBED_DIM = VOICEPRINT_DIM;

function l2norm(v: number[]): number[] {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

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
  const uid = await resolveTarget(session as never, targetUserId);
  if (!uid) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  const withEmbedding = new URL(req.url).searchParams.get("withEmbedding") === "1";
  const cols = withEmbedding ? "updated_at, sample_secs, sample_count, embedding" : "updated_at, sample_secs, sample_count";
  const rows = await prisma.$queryRawUnsafe<{ updated_at: Date; sample_secs: number | null; sample_count: number; embedding?: unknown }[]>(
    `SELECT ${cols} FROM speaker_voiceprint WHERE user_id = $1`, uid,
  );
  const r = rows[0];
  const out: Record<string, unknown> = { enrolled: !!r, sampleCount: r?.sample_count ?? 0, updatedAt: r?.updated_at ?? null, sampleSecs: r?.sample_secs ?? null, threshold: VOICEPRINT_THRESHOLD };
  // 본인 성문 벡터 반환 — 상시 감시가 기기 안에서 화자 게이팅(비환자 오디오 미전송)하도록. 본인/권한자 한정.
  if (withEmbedding && r?.embedding) out.embedding = r.embedding;
  return NextResponse.json(out);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const rl = await checkRateLimit(`voiceprint:${session.user.id}`, 40, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body?.action;
  const uid = await resolveTarget(session as never, typeof body?.targetUserId === "string" ? body.targetUserId : undefined);
  if (!uid) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  if (action === "reset") {
    await prisma.$executeRawUnsafe(`DELETE FROM speaker_voiceprint_sample WHERE user_id = $1`, uid);
    await prisma.$executeRawUnsafe(`DELETE FROM speaker_voiceprint WHERE user_id = $1`, uid);
    return NextResponse.json({ ok: true, enrolled: false, sampleCount: 0 });
  }

  if (!isEmbedding(body?.embedding)) return NextResponse.json({ error: "임베딩 형식 오류" }, { status: 400 });
  const embedding = l2norm(body.embedding as number[]);

  if (action === "enroll") {
    const sampleSecs = typeof body?.sampleSecs === "number" ? Math.max(0, Math.min(600, body.sampleSecs)) : null;
    // 1) 개별 표본 추가
    await prisma.$executeRawUnsafe(
      `INSERT INTO speaker_voiceprint_sample (id, user_id, embedding, sample_secs) VALUES ($1, $2, $3::jsonb, $4)`,
      randomUUID(), uid, JSON.stringify(embedding), sampleSecs,
    );
    // 2) 전체 표본 평균 → 대표 성문 갱신
    const samples = await prisma.$queryRawUnsafe<{ embedding: unknown }[]>(
      `SELECT embedding FROM speaker_voiceprint_sample WHERE user_id = $1`, uid,
    );
    const dim = EMBED_DIM;
    const mean = new Array(dim).fill(0);
    for (const s of samples) { const e = s.embedding as number[]; for (let i = 0; i < dim; i++) mean[i] += e[i]; }
    for (let i = 0; i < dim; i++) mean[i] /= samples.length;
    const centroid = l2norm(mean);
    await prisma.$executeRawUnsafe(
      `INSERT INTO speaker_voiceprint (user_id, embedding, dim, model, sample_secs, sample_count, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET embedding = EXCLUDED.embedding, dim = EXCLUDED.dim,
         model = EXCLUDED.model, sample_secs = EXCLUDED.sample_secs, sample_count = EXCLUDED.sample_count, updated_at = now()`,
      uid, JSON.stringify(centroid), dim, VOICEPRINT_MODEL_ID, sampleSecs, samples.length,
    );
    return NextResponse.json({ ok: true, enrolled: true, sampleCount: samples.length });
  }

  if (action === "verify") {
    const rows = await prisma.$queryRawUnsafe<{ embedding: unknown }[]>(
      `SELECT embedding FROM speaker_voiceprint WHERE user_id = $1`, uid,
    );
    if (!rows[0]) return NextResponse.json({ error: "등록된 성문이 없습니다." }, { status: 404 });
    const score = cosine(embedding, rows[0].embedding as number[]);
    return NextResponse.json({ score, isSelf: score >= VOICEPRINT_THRESHOLD, threshold: VOICEPRINT_THRESHOLD });
  }

  return NextResponse.json({ error: "알 수 없는 action" }, { status: 400 });
}
