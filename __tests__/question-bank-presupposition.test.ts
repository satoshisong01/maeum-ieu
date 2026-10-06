/**
 * 질문 풀 — 어르신이 **하지 않은 말·일을 전제**하는 문항은 뽑지 않는다 (B13, 2026-10-06 직접 운전).
 *
 * 결함: 확인 질문 "요번 주 손녀가 용돈 쥐여주고 갔다던데, 언제였어요?"에 어르신이 "그런 일 없었는데… 내가 그런 말을
 *   했었나? 요새 내가 정신이 없나 보네"라고 답했다. 정적 풀은 대화 내용을 모르니 이런 전제는 늘 지어낸 것이다.
 */
import { describe, it, expect } from "vitest";
import bank from "@/lib/screening/question-bank.json";
import { sampleQuestionsForDomain, presupposesUnsaid } from "@/lib/screening/question-bank";

type Bank = { items: Record<string, { domain: string; questions: { text: string }[] }> };
const items = (bank as Bank).items;
const DOMAINS = [...new Set(Object.values(items).map((it) => it.domain))];

describe("전제형 문항 판별", () => {
  it.each([
    "요번 주 어느 날 손녀가 용돈 쥐여주고 갔다던데, 그게 언제 일이었어요?",
    "어제 마실 다녀오셨다 그러셨잖아요, 어느 댁에 들르셨던 거예요?",
    "엊그제 장에 다녀오셨다면서요, 봉지에 뭘 그렇게 사 오셨대요?",
    "어제 우리 집에 누가 다녀가셨다 그러셨던 거 같은데, 어느 분이셨어요?",
  ])("전제형: %s", (t) => expect(presupposesUnsaid(t)).toBe(true));

  it.each([
    "오늘 점심엔 뭐 드셨어요? 맛있게 드셨나 궁금해서요.",
    "아까 아침에 숟가락 드신 게 밥이었어요, 죽이었어요?",
    "오늘이 무슨 요일인지 문득 궁금하네요.",
  ])("열린 질문은 그대로: %s", (t) => expect(presupposesUnsaid(t)).toBe(false));
});

describe("추출 — 어느 영역에서도 전제형 문항이 나오지 않는다", () => {
  it.each(DOMAINS)("%s", (domain) => {
    for (let i = 0; i < 60; i++) {
      for (const q of sampleQuestionsForDomain(domain, 3)) {
        // 🔒 2026-10-06 이전: 최근 일 회상 문항의 절반(46/100)이 이런 전제였다
        expect(presupposesUnsaid(q.text), q.text).toBe(false);
      }
    }
  });

  it("거른 뒤에도 영역마다 문항이 충분히 남는다 (다양성)", () => {
    for (const domain of DOMAINS) {
      const left = Object.values(items).filter((it) => it.domain === domain)
        .flatMap((it) => it.questions).filter((q) => !presupposesUnsaid(q.text)).length;
      expect(left, domain).toBeGreaterThanOrEqual(50);
    }
  });
});
