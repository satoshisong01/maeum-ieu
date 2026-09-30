/**
 * DB 정합성 점검 — Prisma가 관리하지 않는 raw SQL 테이블 + 고아 데이터 + 인덱스.
 *
 * 배경: cognitive_assessments·embeddings·medication_log 등은 raw SQL로 만들어 Prisma 관계가 없다.
 *   그래서 ① `prisma db push`가 이 테이블을 drop한 사고 이력이 있고(절대 금지)
 *          ② 계정 삭제 시 Cascade가 걸리지 않아 개인정보가 고아로 남을 수 있다.
 *
 * 읽기 전용 — 데이터를 수정하지 않는다.
 * 사용: npx tsx scripts/db-integrity.ts
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";

const RAW_TABLES = [
  "cognitive_assessments", "embeddings", "medication_log", "exam_session",
  "expert_patient", "expert_access_log", "mental_assessment", "mental_answer",
  "voiceprint", "voiceprint_samples", "summary",
];

let warn = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => { warn++; console.log(`  ⚠ ${m}`); };

async function main() {
  console.log("[1] raw SQL 테이블 존재 여부");
  const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const have = new Set(rows.map((r) => r.table_name));
  console.log(`  전체 테이블 ${have.size}개`);
  for (const t of RAW_TABLES) {
    if (have.has(t)) ok(`${t} 존재`);
    else console.log(`  · ${t} 없음(이 배포에서 미사용일 수 있음)`);
  }

  console.log("\n[2] 고아 데이터 — 삭제된 사용자의 잔여 개인정보");
  for (const t of RAW_TABLES) {
    if (!have.has(t)) continue;
    const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, t);
    const userCol = cols.find((c) => c.column_name === "user_id")?.column_name
      ?? cols.find((c) => c.column_name === "userId")?.column_name;
    if (!userCol) { console.log(`  · ${t}: user 컬럼 없음 — 건너뜀`); continue; }
    const q = `SELECT COUNT(*)::int AS c FROM "${t}" t WHERE t."${userCol}" IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = t."${userCol}")`;
    try {
      const r = await prisma.$queryRawUnsafe<{ c: number }[]>(q);
      const c = r[0]?.c ?? 0;
      if (c === 0) ok(`${t}: 고아 0건`);
      else bad(`${t}: 고아 ${c}건 — 계정 삭제 후 개인정보 잔존(FK/Cascade 없음)`);
    } catch (e) {
      console.log(`  · ${t}: 조회 실패 — ${e instanceof Error ? e.message.slice(0, 70) : e}`);
    }
  }

  console.log("\n[3] 외래키 제약 — user_id에 FK가 걸려 있는가");
  const fks = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
  const fkSet = new Set(fks.map((f) => `${f.table_name}.${f.column_name}`));
  for (const t of RAW_TABLES) {
    if (!have.has(t)) continue;
    const hasFk = [...fkSet].some((k) => k.startsWith(`${t}.`) && /user/i.test(k));
    if (hasFk) ok(`${t}: user FK 있음 → 계정 삭제 시 연쇄 처리`);
    else bad(`${t}: user FK 없음 → 계정 삭제 시 수동 정리 필요`);
  }

  console.log("\n[4] 인덱스 — 자주 조회되는 컬럼");
  const idx = await prisma.$queryRawUnsafe<{ tablename: string; indexdef: string }[]>(
    `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`);
  for (const t of ["cognitive_assessments", "Message", "embeddings"]) {
    if (!have.has(t)) continue;
    const mine = idx.filter((i) => i.tablename === t);
    const hasUser = mine.some((i) => /user_id|userId|conversationId/i.test(i.indexdef));
    if (hasUser) ok(`${t}: 사용자/대화 인덱스 있음 (${mine.length}개 인덱스)`);
    else bad(`${t}: 사용자/대화 인덱스 없음 → 사용자 증가 시 조회 지연`);
  }

  console.log("\n[5] 데이터 규모");
  for (const t of ["User", "Conversation", "Message", "cognitive_assessments"]) {
    if (!have.has(t)) continue;
    const r = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*)::int AS c FROM "${t}"`);
    console.log(`  ${t}: ${(r[0]?.c ?? 0).toLocaleString()}행`);
  }

  console.log(`\n경고 ${warn}건`);
}

main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
