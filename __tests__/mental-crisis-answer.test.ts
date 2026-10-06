/**
 * 일반인 정신건강 점검 — **위기 문항(PHQ-9 9번)** 양성 답이 L3와 겹칠 때 (B2, 2026-10-06 직접 운전).
 *
 * 결함: "며칠 정도요. 그냥 다 내려놓고 사라지고 싶다는 생각이 가끔 들었어요."가 L3로 잡혀 위기 즉답이 먼저 나가고
 *   **9번 답이 기록되지 않았다.** 다음 턴("결과는 어떻게 나왔어요?")에 점검 흐름이 같은 자살 사고 문항을 다시 물었다.
 * 수정: L3 대응(응급 마킹·알림)은 그대로, 위기 문항 양성 답이면 기록하고 점검 흐름의 응답(위기 상담 안내 포함)을 쓴다.
 *   그 외 L3(다른 문항 중의 위기 발화 등)에는 **아무것도 바꾸지 않는다**(세션 시작·중단·재질문 없음).
 *
 * 목 체제: prisma raw SQL(세션·점수). 답 분류는 실제 빠른 경로 — LLM 경로는 키를 비워 끈다.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// 환경변수는 워커 프로세스 단위다 — 지운 키를 되돌려 다음 테스트 파일에 새지 않게 한다
const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
afterAll(() => { if (ORIGINAL_KEY !== undefined) process.env.GEMINI_API_KEY = ORIGINAL_KEY; });

let session: { id: string; scale: string; status: string; current_item: number; retry_used: boolean } | null = null;
const writes: { sql: string; args: unknown[] }[] = [];
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => { writes.push({ sql, args }); return 1; }),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (/FROM mental_session/.test(sql)) return session ? [session] : [];
      if (/FROM mental_assessments/.test(sql)) return Array.from({ length: 9 }, (_, i) => ({ item_no: i + 1, score: 1, total: 9 }));
      return [];
    }),
  },
}));

const { handleMentalFlow } = await import("@/lib/health/mental-flow");
const { CRISIS_GUIDE } = await import("@/lib/screening/mental-bank");

const ANSWER_9 = "며칠 정도요. 그냥 다 내려놓고 사라지고 싶다는 생각이 가끔 들었어요.";
const base = { userId: "u-gen", honorific: "선생님", companionName: "민지", onlyCrisisAnswer: true as const };

beforeEach(() => {
  writes.length = 0;
  delete process.env.GEMINI_API_KEY;   // 분류는 빠른 경로만 — 테스트가 네트워크에 닿지 않게
  session = { id: "s-1", scale: "PHQ9", status: "active", current_item: 9, retry_used: false };
});

describe("위기 문항 양성 답 — 기록하고 위기 안내를 담아 끝낸다", () => {
  it("9번 답을 기록하고(점수 1), 세션을 마치고, 위기 상담 안내가 든 응답을 돌려준다", async () => {
    const r = await handleMentalFlow({ ...base, userContent: ANSWER_9 });
    expect(r?.crisis).toBe(true);
    // 🔒 2026-10-06 이전: 이 답이 기록되지 않아 다음 턴에 같은 자살 사고 문항을 다시 물었다
    const insert = writes.find((w) => /INSERT INTO mental_assessments/.test(w.sql));
    expect(insert?.args.slice(3)).toEqual([9, 1]);
    expect(writes.some((w) => /status = 'done'/.test(w.sql))).toBe(true);
    expect(r?.reply).toContain(CRISIS_GUIDE);
  });
});

describe("그 외 L3에는 점검 상태를 건드리지 않는다", () => {
  it("위기 문항이 아닌 문항 중의 위기 발화 → null, 쓰기 없음", async () => {
    session = { ...session!, current_item: 3 };
    expect(await handleMentalFlow({ ...base, userContent: ANSWER_9 })).toBeNull();
    expect(writes.filter((w) => !/lazy|30 minutes/.test(w.sql))).toEqual([]);
  });

  it("위기 문항이라도 빈도로 분류되지 않는 답 → null (재질문·retry_used 소모 없음)", async () => {
    expect(await handleMentalFlow({ ...base, userContent: "죽고 싶어요" })).toBeNull();
    expect(writes.some((w) => /retry_used = true/.test(w.sql))).toBe(false);
  });

  it("점검 세션이 없으면 → null (위기 발화로 점검을 시작하지 않는다)", async () => {
    session = null;
    expect(await handleMentalFlow({ ...base, userContent: "마음 건강 체크 해볼래요. 죽고 싶어요" })).toBeNull();
    expect(writes.some((w) => /INSERT INTO mental_session/.test(w.sql))).toBe(false);
  });

  it("'그만'이 섞여도 점검 중단으로 읽지 않는다", async () => {
    const r = await handleMentalFlow({ ...base, userContent: "며칠 정도요. 다 그만하고 싶다는 생각이 들었어요." });
    expect(writes.some((w) => /status = 'aborted'/.test(w.sql) && !/30 minutes/.test(w.sql))).toBe(false);
    expect(r?.crisis).toBe(true);
  });
});

describe("라우트 연결 — 음성·텍스트 두 L3 분기 모두", () => {
  it("handleEmergencyL3에 점검 응답을 넘긴다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("app/api/chat/route.ts", "utf-8");
    // 🔒 한 경로만 고치면 실서비스(음성)에서 그대로 다시 묻는다
    expect(src.match(/replyOverride: await mentalCrisisReply\(mode, userId, /g)?.length).toBe(2);
    expect(src).toMatch(/const reply = params\.replyOverride \?\? buildEmergencyL3Reply\(/);
  });
});
