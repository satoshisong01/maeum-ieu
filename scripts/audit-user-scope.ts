/**
 * User-scope audit — 모든 사용자 데이터 테이블 쿼리가 user_id/userId/conversationId 필터를 가지는지 정적 검증.
 *
 * 검사 대상 (사용자 격리 필수 테이블):
 *   - "Message", "Conversation"   (Prisma)
 *   - message_embeddings, cognitive_assessments  (raw SQL)
 *   - user_profile, family_member, user_fact     (Phase 1)
 *
 * 발견 시 console.error로 보고. CI에서 exit code !=0 으로 fail 가능.
 *
 * 한계: 정적 분석이라 indirect query는 못 잡음. 핵심 패턴만 catch.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["lib", "app/api"];
const TABLES = [
  { name: "Message", pattern: /prisma\.message\.|"Message"/g, requireFilter: /userId|conversationId|conversation:\s*{/ },
  { name: "Conversation", pattern: /prisma\.conversation\.|"Conversation"/g, requireFilter: /userId|user:\s*{/ },
  { name: "message_embeddings", pattern: /message_embeddings/g, requireFilter: /user_id\s*=\s*\$/ },
  { name: "cognitive_assessments", pattern: /cognitive_assessments/g, requireFilter: /user_id\s*=\s*\$/ },
  { name: "user_profile", pattern: /user_profile/g, requireFilter: /user_id\s*=\s*\$|WHERE\s+user_id/ },
  { name: "family_member", pattern: /family_member/g, requireFilter: /user_id\s*=\s*\$|WHERE\s+user_id/ },
  { name: "user_fact", pattern: /user_fact/g, requireFilter: /user_id\s*=\s*\$|WHERE\s+user_id/ },
];

interface Violation {
  file: string;
  table: string;
  line: number;
  snippet: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".next" || ent.name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(file: string): Violation[] {
  const text = fs.readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const violations: Violation[] = [];

  for (const t of TABLES) {
    // 각 라인에서 테이블 등장 → 그 라인 ± 30 라인 context에서 필터 확인
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      t.pattern.lastIndex = 0;
      if (!t.pattern.test(line)) continue;
      // 주석/문자열 정의 등 false positive 제외
      if (/^\s*(\*|\/\/|---|#)/.test(line)) continue;
      if (/CREATE\s+TABLE|CREATE\s+INDEX|DROP\s+TABLE/i.test(line)) continue;
      if (file.includes("schema.prisma") || file.includes("migrations")) continue;
      // INSERT / CONFLICT / EXCLUDED — user_id를 column에 명시하는 경우는 safe
      if (/INSERT\s+INTO|ON\s+CONFLICT|EXCLUDED\./i.test(line)) continue;
      // ALTER, GRANT, ENABLE, POLICY 등 DDL
      if (/ALTER\s+TABLE|GRANT\s+|ENABLE\s+ROW|POLICY/i.test(line)) continue;

      // 30라인 context 범위에서 필터 확인
      const ctx = lines.slice(Math.max(0, i - 5), i + 30).join("\n");
      if (!t.requireFilter.test(ctx)) {
        violations.push({
          file: path.relative(ROOT, file),
          table: t.name,
          line: i + 1,
          snippet: line.trim().slice(0, 140),
        });
      }
    }
  }
  return violations;
}

function main() {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
  console.log(`Scanning ${files.length} files...`);

  const all: Violation[] = [];
  for (const f of files) all.push(...scanFile(f));

  if (all.length === 0) {
    console.log("✓ Audit clean — all user-scoped queries have proper filters");
    process.exit(0);
  }

  console.error(`\n❌ Found ${all.length} potential user-scope violations:\n`);
  for (const v of all) {
    console.error(`  ${v.file}:${v.line} [${v.table}]`);
    console.error(`    ${v.snippet}`);
  }
  console.error("\nReview each: ensure user_id/userId/conversationId is part of the WHERE clause.");
  process.exit(1);
}
main();
