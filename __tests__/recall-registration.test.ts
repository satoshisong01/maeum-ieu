/**
 * 기억력 놀이(단어 등록) 감지 — 질문 풀 **전수**로 고정한다.
 *
 * 결함(2026-10-06 직접 운전): 우회 표현의 등록("제가 부르면 받아주세요. 백로, 옹기, 부삽.")을 회상 힌트가
 *   못 알아봐, 어르신이 "아까 그 세 단어 뭐였더라?"라고 묻자 동반자에게 "단어를 외워드린 적이 없다"고
 *   알렸고 동반자는 "혹시 어디서 다른 단어를 들으셨을까요?"라고 되물었다. 분석기도 그 회상 실패를 놓쳤다.
 * 측정(도입 시): 등록 문항 100/100 감지·단어 일치 100/100, 나머지 3,788문항 오탐 0
 *   (첫 버전은 숫자 거꾸로 따라하기 14건을 등록으로 오인 → 숫자 낱말 제외).
 */
import { describe, it, expect } from "vitest";
import bank from "@/lib/screening/question-bank.json";
import { extractRegisteredWords, findRegisteredWordsInHistory } from "@/lib/chat/recall-registration";

type Bank = { items: Record<string, { questions: { text: string }[] }> };
const items = (bank as Bank).items;
const REG_KEY = "memory_immediate:three_words_register";

describe("질문 풀 전수", () => {
  it("등록 문항 100개를 전부 감지하고, 끝의 세 낱말을 그대로 뽑는다", () => {
    const qs = items[REG_KEY].questions;
    expect(qs.length).toBeGreaterThanOrEqual(100);
    const misses: string[] = [];
    for (const q of qs) {
      const w = extractRegisteredWords(q.text);
      const tail = q.text.match(/([가-힣]+)\s*,\s*([가-힣]+)\s*,\s*([가-힣]+)\s*[.!]?\s*$/);
      if (!w || (tail && w.join() !== [tail[1], tail[2], tail[3]].join())) misses.push(q.text);
    }
    expect(misses).toEqual([]);
  });

  it("나머지 문항(일상 수다·다른 영역)은 등록으로 보지 않는다 — 숫자 거꾸로 따라하기 포함", () => {
    const fps: string[] = [];
    for (const [k, v] of Object.entries(items)) {
      if (k === REG_KEY) continue;
      for (const q of v.questions) if (extractRegisteredWords(q.text)) fps.push(`${k} | ${q.text}`);
    }
    expect(fps).toEqual([]);
  });
});

describe("실제 대화", () => {
  it("직접 운전에서 놓친 그 등록 발화", () => {
    const ai = "할머니가 누렁이를 정말 살뜰하게 챙겨주셨군요. 심심풀이로 재미 삼아 하나 해볼까요? 하얀 백로 보니 셋이 사뿐 내려앉네요. 제가 부르면 할머니가 받아주세요. 백로, 옹기, 부삽.";
    expect(extractRegisteredWords(ai)).toEqual(["백로", "옹기", "부삽"]);
  });

  it("표준 문항(MMSE-K 3단어·MoCA-K 5단어)", () => {
    expect(extractRegisteredWords("민지가 단어 세 개 말씀드릴게요. 잠깐 외워보세요~ 나무, 자동차, 모자. 이따 한번만 다시 말씀해주실래요?")).toEqual(["나무", "자동차", "모자"]);
    expect(extractRegisteredWords("5초만 외워주세요: 얼굴, 비단, 교회, 카네이션, 빨강. 좀 있다 여쭤볼게요")).toEqual(["얼굴", "비단", "교회", "카네이션", "빨강"]);
  });

  it.each([
    "사과, 배, 감 중에 뭐 좋아하세요?",
    "오늘 반찬은 김치, 멸치, 콩나물이었어요?",
    "다음엔 숫자 세 개 불러볼게요. 사, 칠, 이.",
  ])("등록 아님: %s", (t) => {
    expect(extractRegisteredWords(t)).toBeNull();
  });

  it("이력에서는 가장 최근 등록을 찾는다 (시간 라벨 있어도)", () => {
    const h = [
      "[1시간 전] AI: 제가 셋 부를게요, 그대로. 달팽이, 항아리, 부지깽이.",
      "[1시간 전] 사용자: 달팽이, 항아리, 부지깽이",
      "[방금] AI: 하얀 백로 보니 셋이 사뿐 내려앉네요. 제가 부르면 받아주세요. 백로, 옹기, 부삽.",
      "[방금] 사용자: 백로, 옹기, 부삽",
    ].join("\n");
    expect(findRegisteredWordsInHistory(h)).toEqual(["백로", "옹기", "부삽"]);
    expect(findRegisteredWordsInHistory("사용자: 백로, 옹기, 부삽 외워야지")).toBeNull(); // 사용자 발화는 등록이 아니다
  });
});
