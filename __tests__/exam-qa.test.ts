/**
 * 검진 '문답 기록' — 검진 테이블에서만 재구성한다(일상 대화가 구조적으로 섞일 수 없게).
 *
 * 2026-10-06 이전: "검진 시작~종료(최대 30분) 사이의 모든 메시지"를 문답 기록으로 보여줘,
 *   검진을 시작만 해 두면 그 사이 환자의 일상 대화·감시 혼잣말이 전문가 화면에 원문째 떴다.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { buildExamQa, type ExamItemRow } from "@/lib/screening/exam-qa";
import { itemsForDomain, renderDomainBattery } from "@/lib/screening/exam-runner";

const t = (s: number) => new Date(Date.UTC(2026, 9, 6, 1, 0, s));

describe("재구성 규칙", () => {
  it("같은 영역·같은 답의 문항 행들을 한 번의 문답으로 묶는다", () => {
    const rows: ExamItemRow[] = [
      { domain: "orientation_time", prompt: "올해는 몇 년도인가요?", answer: "2026년", created_at: t(1) },
      { domain: "orientation_time", prompt: "지금은 무슨 계절인가요?", answer: "2026년", created_at: t(1) },
      { domain: "memory_immediate", prompt: "세 단어를 따라 해 보세요.", answer: "나무 자동차 모자", created_at: t(9) },
    ];
    expect(buildExamQa(rows)).toEqual([
      { role: "assistant", content: "올해는 몇 년도인가요? 지금은 무슨 계절인가요?", at: t(1).toISOString() },
      { role: "user", content: "2026년", at: t(1).toISOString() },
      { role: "assistant", content: "세 단어를 따라 해 보세요.", at: t(9).toISOString() },
      { role: "user", content: "나무 자동차 모자", at: t(9).toISOString() },
    ]);
  });

  it("질문 문장은 환자가 실제로 들은 문장(renderDomainBattery)과 같다", () => {
    const domain = "orientation_time";
    const rows: ExamItemRow[] = itemsForDomain(domain).map((it) => ({ domain, prompt: it.prompt, answer: "x", created_at: t(1) }));
    // 🔒 재구성한 질문이 실제 질문과 다르면 의사가 "무엇을 물었는지"를 잘못 읽는다
    expect(buildExamQa(rows)[0].content).toBe(renderDomainBattery(domain));
  });

  it("무응답은 '(무응답)'으로 남는다", () => {
    const qa = buildExamQa([{ domain: "language", prompt: "따라 해 보세요.", answer: "", created_at: t(1) }]);
    expect(qa[1]).toEqual({ role: "user", content: "(무응답)", at: t(1).toISOString() });
  });

  it("같은 영역이라도 답이 다르면 다른 문답이다", () => {
    const qa = buildExamQa([
      { domain: "language", prompt: "A", answer: "가", created_at: t(1) },
      { domain: "language", prompt: "B", answer: "나", created_at: t(2) },
    ]);
    expect(qa.map((b) => b.content)).toEqual(["A", "가", "B", "나"]);
  });
});

describe("🔒 상세 라우트는 검진 블록에서 메시지 테이블을 읽지 않는다", () => {
  it("검진 세션 구간에 prisma.message 조회가 없다", async () => {
    const src = await readFile("app/api/expert/patients/[id]/route.ts", "utf-8");
    const start = src.indexOf("let examSessions");
    const end = src.indexOf("examSessions = built;");
    expect(start, "검진 블록 시작을 못 찾음").toBeGreaterThan(0);
    expect(end, "검진 블록 끝을 못 찾음").toBeGreaterThan(start);
    const block = src.slice(start, end);
    // 메시지 테이블을 시간 창으로 읽는 순간 일상 대화가 다시 문답 기록에 섞인다
    expect(block).not.toMatch(/prisma\.message\./);
    expect(block).not.toMatch(/FROM\s+"Message"/i);
    expect(block).toMatch(/buildExamQa\(itemRows\)/);
  });
});
