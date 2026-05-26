/**
 * 사용자 프로필 — 구조화된 사실 슬롯 접근 (UserProfile / FamilyMember / UserFact).
 *
 * 목적: prompt와 RAG에만 의존하던 사실 관리를 명시적 슬롯으로 옮김.
 *   - prompt fix가 누적되어 LLM이 우선순위 못 잡는 문제 해결
 *   - 응답 fact-check 시 명확한 ground truth 제공
 *   - 사용자 간 데이터 누수 차단 (오늘 abc → rudtjrch 환각 사고 방지)
 */

import { prisma } from "@/lib/prisma";

export type FamilyRelation =
  | "son" | "daughter" | "grandchild" | "spouse" | "sibling"
  | "nephew" | "niece" | "parent" | "other";

export interface UserProfile {
  userId: string;
  hometown: string | null;
  residence: string | null;
  spouseStatus: string | null;
  spouseName: string | null;
  occupation: string | null;
  hobbies: string | null;
  favoriteFoods: string | null;
  healthNotes: string | null;
  notes: string | null;
}

export interface FamilyMember {
  id: string;
  userId: string;
  name: string;
  relation: FamilyRelation;
  orderIdx: number | null;
  notes: string | null;
}

export interface UserFact {
  id: string;
  userId: string;
  factKey: string;
  factValue: string;
  confidence: number;
}

export interface FullProfile {
  profile: UserProfile | null;
  family: FamilyMember[];
  facts: UserFact[];
}

export async function getFullProfile(userId: string): Promise<FullProfile> {
  const [profile, family, facts] = await Promise.all([
    prisma.$queryRawUnsafe<UserProfile[]>(
      `SELECT user_id AS "userId", hometown, residence, spouse_status AS "spouseStatus", spouse_name AS "spouseName",
              occupation, hobbies, favorite_foods AS "favoriteFoods", health_notes AS "healthNotes", notes
       FROM user_profile WHERE user_id = $1`, userId,
    ),
    prisma.$queryRawUnsafe<FamilyMember[]>(
      `SELECT id, user_id AS "userId", name, relation, order_idx AS "orderIdx", notes
       FROM family_member WHERE user_id = $1 ORDER BY relation, order_idx NULLS LAST, name`, userId,
    ),
    prisma.$queryRawUnsafe<UserFact[]>(
      `SELECT id, user_id AS "userId", fact_key AS "factKey", fact_value AS "factValue", confidence
       FROM user_fact WHERE user_id = $1 ORDER BY fact_key`, userId,
    ),
  ]);
  return { profile: profile[0] ?? null, family, facts };
}

export async function upsertProfile(userId: string, patch: Partial<Omit<UserProfile, "userId">>): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [userId];
  let i = 2;
  const colMap: Record<string, string> = {
    hometown: "hometown", residence: "residence", spouseStatus: "spouse_status", spouseName: "spouse_name",
    occupation: "occupation", hobbies: "hobbies", favoriteFoods: "favorite_foods",
    healthNotes: "health_notes", notes: "notes",
  };
  const inserts: string[] = ["user_id"];
  const placeholders: string[] = ["$1"];
  for (const [k, v] of Object.entries(patch)) {
    const col = colMap[k];
    if (!col || v == null) continue;
    inserts.push(col);
    placeholders.push(`$${i}`);
    fields.push(`${col} = EXCLUDED.${col}`);
    values.push(v);
    i++;
  }
  if (fields.length === 0) return;

  await prisma.$executeRawUnsafe(
    `INSERT INTO user_profile (${inserts.join(",")}, updated_at) VALUES (${placeholders.join(",")}, NOW())
     ON CONFLICT (user_id) DO UPDATE SET ${fields.join(", ")}, updated_at = NOW()`,
    ...values,
  );
}

export async function upsertFamilyMember(userId: string, member: {
  name: string;
  relation: FamilyRelation;
  orderIdx?: number | null;
  notes?: string | null;
  sourceMessageId?: string | null;
}): Promise<void> {
  const id = `fm_${userId.slice(0, 8)}_${member.name}_${Date.now()}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO family_member (id, user_id, name, relation, order_idx, notes, source_message_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, name) DO UPDATE SET
       relation = EXCLUDED.relation,
       order_idx = COALESCE(EXCLUDED.order_idx, family_member.order_idx),
       notes = COALESCE(EXCLUDED.notes, family_member.notes),
       source_message_id = COALESCE(EXCLUDED.source_message_id, family_member.source_message_id),
       updated_at = NOW()`,
    id, userId, member.name, member.relation, member.orderIdx ?? null,
    member.notes ?? null, member.sourceMessageId ?? null,
  );
}

export async function upsertFact(userId: string, fact: {
  key: string;
  value: string;
  confidence?: number;
  sourceMessageId?: string | null;
}): Promise<void> {
  const id = `uf_${userId.slice(0, 8)}_${fact.key}_${Date.now()}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_fact (id, user_id, fact_key, fact_value, confidence, source_message_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, fact_key) DO UPDATE SET
       fact_value = EXCLUDED.fact_value,
       confidence = GREATEST(user_fact.confidence, EXCLUDED.confidence),
       source_message_id = COALESCE(EXCLUDED.source_message_id, user_fact.source_message_id),
       updated_at = NOW()`,
    id, userId, fact.key, fact.value, fact.confidence ?? 0.8, fact.sourceMessageId ?? null,
  );
}

/** Profile을 prompt에 넣기 위한 사람-읽기-쉬운 문자열로 변환. */
export function renderProfileForPrompt(profile: FullProfile): string {
  const lines: string[] = [];

  // 가족 — 가장 critical (이름 환각 차단)
  if (profile.family.length > 0) {
    const RELATION_KO: Record<string, string> = {
      son: "아들", daughter: "딸", grandchild: "손주",
      spouse: "배우자", sibling: "형제자매", nephew: "조카", niece: "조카",
      parent: "부모", other: "친척",
    };
    const byRel = new Map<string, FamilyMember[]>();
    for (const m of profile.family) {
      const arr = byRel.get(m.relation) || [];
      arr.push(m);
      byRel.set(m.relation, arr);
    }
    const familyParts: string[] = [];
    for (const [rel, members] of byRel) {
      const ko = RELATION_KO[rel] || rel;
      const sorted = members.slice().sort((a, b) => (a.orderIdx ?? 99) - (b.orderIdx ?? 99));
      const desc = sorted.map((m) => {
        const order = m.orderIdx != null ? ["첫째", "둘째", "셋째", "넷째", "다섯째"][m.orderIdx - 1] : null;
        const orderTag = order ? `${order} ` : "";
        const noteTag = m.notes ? ` (${m.notes})` : "";
        return `${orderTag}${ko} ${m.name}${noteTag}`;
      }).join(", ");
      familyParts.push(desc);
    }
    lines.push(`- 가족: ${familyParts.join(" / ")}`);
  }

  const p = profile.profile;
  if (p) {
    if (p.hometown) lines.push(`- 고향: ${p.hometown}`);
    if (p.residence) lines.push(`- 현 거주지: ${p.residence}`);
    if (p.spouseStatus === "bereaved") lines.push(`- 배우자: ${p.spouseName || "안사람"} (사별)`);
    else if (p.spouseStatus === "alive" && p.spouseName) lines.push(`- 배우자: ${p.spouseName}`);
    if (p.occupation) lines.push(`- 직업: ${p.occupation}`);
    if (p.hobbies) lines.push(`- 취미: ${p.hobbies}`);
    if (p.favoriteFoods) lines.push(`- 좋아하는 음식: ${p.favoriteFoods}`);
    if (p.healthNotes) lines.push(`- 건강 메모: ${p.healthNotes}`);
  }

  for (const f of profile.facts) {
    lines.push(`- ${f.factKey}: ${f.factValue}`);
  }

  if (lines.length === 0) return "";
  return `[사용자 확정 정보 — 추측·환각 금지, 이 정보만 정답으로 사용]\n${lines.join("\n")}`;
}
