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
  /** 해당 줄 + 다음 몇 줄 — where절은 보통 다음 줄에 오므로 핸들링에 필요하다 */
  head: string;
}

/**
 * 검토 완료된 예외 — **근거를 코드에 남긴다.**
 *
 * 왜 필요한가: 이 감사는 "사람이 검토하라"는 트리거인데, 검토 결과를 적어둘 곳이 없어서
 *   매 실행이 같은 8건으로 레드였다. 상시 레드인 게이트는 **아무도 보지 않게 되고**,
 *   그 사이에 진짜 위반이 섞여 들어와도 구분되지 않는다(2026-10-02 적발:
 *   가이드 §6 5단계 합격 기준이 '0건'인데 8건으로 실패 중인 것을 보고서에 아예 안 적었다).
 *
 * 규칙:
 *   · `match`는 그 줄의 **특징적 일부**다. 코드가 바뀌면 일치가 깨져 **다시 올라온다** —
 *     의도된 방향이다(조용히 묻히는 것보다 다시 검토하는 게 낫다).
 *   · 예외는 "왜 사용자 격리가 보장되는가"를 적어야 한다. "확인했음"은 근거가 아니다.
 *   · 아래 목록은 줄어들기만 해야 한다. 추가하려면 그 쿼리가 왜 안전한지 먼저 증명할 것.
 */
const ACKNOWLEDGED: { file: string; table: string; match: string; reason: string }[] = [
  {
    file: "lib/chat/constants.ts", table: "cognitive_assessments",
    match: "이미 평가 완료된 단어/도메인은",
    reason: "쿼리가 아니라 **프롬프트 문자열**이다. 테이블명을 설명으로 언급할 뿐 DB에 닿지 않는다.",
  },
  {
    file: "lib/chat/emergency-notify.ts", table: "Message",
    match: "where: { id: payload.messageId }",
    reason:
      "messageId는 **같은 턴에 서버가 직접 만든** 메시지의 id(saveMessages 반환값)이고, " +
      "클라이언트 입력이 아니다. 쓰는 필드도 notifiedAt 하나뿐 — 남의 메시지를 지정할 경로가 없다.",
  },
  {
    file: "lib/chat/messages.ts", table: "Conversation",
    match: "where: { id: conversationId }",
    reason:
      "saveGreetingMessage의 conversationId는 세션에서 유도된 현재 대화 id이고, 쓰는 필드는 " +
      "updatedAt 하나뿐이다. 호출부가 소유권 검증 뒤에 넘긴다.",
  },
];

/** 이 위반이 검토 완료 목록에 있는가 */
function acknowledgedOf(v: Violation) {
  const f = v.file.replace(/\\/g, "/");
  return ACKNOWLEDGED.find((a) => f === a.file && a.table === v.table && v.head.includes(a.match));
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
      // 줄 끝 주석은 코드가 아니다 — `domain: string;  // cognitive_assessments …`가 위반으로 잡혔다.
      //   (URL의 `//`는 테이블명과 무관하므로 단순 제거로 충분하다)
      const code = line.replace(/\/\/.*$/, "");
      t.pattern.lastIndex = 0;
      if (!t.pattern.test(code)) continue;
      // 주석/문자열 정의 등 false positive 제외
      //   ⚠ `/**`·`/*`를 빼먹어 JSDoc 첫 줄이 '위반'으로 잡혔다(2026-10-02). 주석은 쿼리가 아니다.
      //     그 결과 매 실행이 8건 레드로 나와, 진짜 위반이 섞여 들어와도 구분되지 않았다.
      if (/^\s*(\*|\/\*|\/\/|---|#)/.test(line)) continue;
      if (/CREATE\s+TABLE|CREATE\s+INDEX|DROP\s+TABLE/i.test(line)) continue;
      if (file.includes("schema.prisma") || file.includes("migrations")) continue;
      // INSERT / CONFLICT / EXCLUDED — user_id를 column에 명시하는 경우는 safe
      if (/INSERT\s+INTO|ON\s+CONFLICT|EXCLUDED\./i.test(line)) continue;
      // ALTER, GRANT, ENABLE, POLICY 등 DDL
      if (/ALTER\s+TABLE|GRANT\s+|ENABLE\s+ROW|POLICY/i.test(line)) continue;

      /**
       * context 범위에서 필터 확인.
       *
       * ⚠ 뒤쪽을 5줄만 보다가, **바로 위에서 소유권을 검증하는 정상 코드**를 위반으로 잡았다
       *   (app/api/messages/speaker/route.ts — findUnique로 conversation.userId를 읽어
       *    session.user.id와 비교한 뒤 update). 그 패턴이 이 저장소의 표준 형태라
       *   5줄 창은 거의 항상 놓친다. 25줄로 넓혔다.
       *   넓히면 놓칠 위험(진짜 위반 위에 우연히 userId가 있는 경우)이 생기지만, 이 감사는
       *   **사람 검토를 트리거하는 장치**이고, 상시 레드는 그 검토 자체를 멈추게 만든다.
       */
      const ctx = lines.slice(Math.max(0, i - 25), i + 30).join("\n");
      if (!t.requireFilter.test(ctx)) {
        violations.push({
          file: path.relative(ROOT, file),
          table: t.name,
          line: i + 1,
          snippet: line.trim().slice(0, 140),
          head: lines.slice(i, i + 6).join(" "),
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

  const known = all.filter((v) => acknowledgedOf(v));
  const fresh = all.filter((v) => !acknowledgedOf(v));

  // 검토 완료분은 **숨기지 않고** 보여준다 — 근거째로 눈에 보여야 재검토가 가능하다
  if (known.length > 0) {
    console.log(`\n검토 완료 예외 ${known.length}건 (근거는 ACKNOWLEDGED 참조):`);
    for (const v of known) console.log(`  · ${v.file}:${v.line} [${v.table}] — ${acknowledgedOf(v)!.reason.slice(0, 80)}…`);
  }

  // 목록에 적어두고 실제로는 사라진 예외 — 방치하면 다음에 같은 패턴이 조용히 통과한다
  const stale = ACKNOWLEDGED.filter((a) => !all.some((v) => acknowledgedOf(v) === a));
  if (stale.length > 0) {
    console.log(`\n⚠ 이제 잡히지 않는 예외 ${stale.length}건 — ACKNOWLEDGED에서 지울 것:`);
    for (const a of stale) console.log(`  · ${a.file} [${a.table}] ${a.match}`);
  }

  if (fresh.length === 0) {
    console.log(`\n✓ Audit clean — 새 위반 0건 (검토 완료 ${known.length}건 제외)`);
    process.exit(0);
  }

  console.error(`\n❌ Found ${fresh.length} potential user-scope violations:\n`);
  for (const v of fresh) {
    console.error(`  ${v.file}:${v.line} [${v.table}]`);
    console.error(`    ${v.snippet}`);
  }
  console.error("\nReview each: ensure user_id/userId/conversationId is part of the WHERE clause.");
  console.error("오탐이면 ACKNOWLEDGED에 **근거와 함께** 추가할 것 — '확인했음'은 근거가 아니다.");
  process.exit(1);
}
main();
