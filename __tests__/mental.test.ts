/** T3 정신건강 검진 — 질문지 무결성 + 응답 분류 fast-path + 해석 컷오프 */
import { describe, it, expect } from "vitest";
import { PHQ9_ITEMS, GAD7_ITEMS, UCLA3_ITEMS, BFI10_ITEMS, SCALES, interpretPHQ9, interpretGAD7, interpretUCLA3, interpretBFI10Profile } from "@/lib/screening/mental-bank";
import { classifyFast, classifyAgree5Fast, classifyFreq3Fast } from "@/lib/health/mental-scorer";

describe("PHQ9_ITEMS 무결성", () => {
  it("9문항, 각 2개 이상 변형, 9번만 crisis", () => {
    expect(PHQ9_ITEMS).toHaveLength(9);
    PHQ9_ITEMS.forEach((item, i) => {
      expect(item.no).toBe(i + 1);
      expect(item.variants.length).toBeGreaterThanOrEqual(2);
      expect(!!item.crisis).toBe(item.no === 9);
    });
  });
});

describe("GAD7_ITEMS·SCALES 무결성", () => {
  it("GAD-7은 7문항, crisis 문항 없음", () => {
    expect(GAD7_ITEMS).toHaveLength(7);
    GAD7_ITEMS.forEach((item, i) => {
      expect(item.no).toBe(i + 1);
      expect(item.variants.length).toBeGreaterThanOrEqual(2);
      expect(!!item.crisis).toBe(false);
    });
  });
  it("레지스트리 maxTotal 정확 (PHQ9=27, GAD7=21)", () => {
    expect(SCALES.PHQ9.maxTotal).toBe(27);
    expect(SCALES.GAD7.maxTotal).toBe(21);
  });
  it("GAD-7 컷오프: 4 정상 / 9 가벼움 / 14 중간 / 15+ 심함", () => {
    expect(interpretGAD7(4).severity).toBe("정상");
    expect(interpretGAD7(9).severity).toBe("가벼운 수준");
    expect(interpretGAD7(14).severity).toBe("중간 수준");
    expect(interpretGAD7(15).severity).toBe("심한 수준");
    expect(interpretGAD7(10).recommend).toBe(true);
  });
});

describe("UCLA-3·BFI-10 무결성", () => {
  it("UCLA-3은 3문항(빈도 1~3), BFI-10은 10문항(동의 0~4, 역문항 5개)", () => {
    expect(UCLA3_ITEMS).toHaveLength(3);
    expect(BFI10_ITEMS).toHaveLength(10);
    expect(BFI10_ITEMS.filter((i) => i.reverse)).toHaveLength(5);
    expect(SCALES.UCLA3.maxTotal).toBe(9);
    expect(SCALES.UCLA3.answerType).toBe("freq3");
    expect(SCALES.BFI10.answerType).toBe("agree5");
    expect(SCALES.BFI10.interpretItems).toBeDefined();
  });
  it("UCLA-3 컷오프: 5 정상 / 7 다소 높음 / 8+ 높음(권고)", () => {
    expect(interpretUCLA3(5).severity).toBe("정상");
    expect(interpretUCLA3(7).severity).toBe("다소 높음");
    expect(interpretUCLA3(8).severity).toBe("높음");
    expect(interpretUCLA3(8).recommend).toBe(true);
  });
  it("BFI-10 프로파일: 요인별 합산(역채점은 저장 시 반영된 값 기준)", () => {
    // 전 문항 4점이면 모든 요인 8/8
    const all4 = BFI10_ITEMS.map((i) => ({ itemNo: i.no, score: 4 }));
    const p = interpretBFI10Profile(all4);
    expect(p.severity).toBe("프로파일");
    expect(p.text).toContain("외향성 8/8");
    expect(p.text).toContain("개방성 8/8");
    expect(p.recommend).toBe(false);
  });
});

describe("classifyAgree5Fast — 동의 척도", () => {
  it.each([
    ["매우 그렇지, 딱 내 얘기야", 4], ["정말 그래", 4],
    ["그런 편이지", 3], ["맞아 맞아", 3],
    ["보통이야, 반반인 것 같아", 2],
    ["아닌 편이야", 1], ["별로 안 그래", 1],
    ["전혀 아니야", 0], ["절대 아니지", 0],
  ])("'%s' → %d", (a, e) => expect(classifyAgree5Fast(a as string)).toBe(e));
  it("모호하면 -1", () => expect(classifyAgree5Fast("글쎄 그게 무슨 말이야")).toBe(-1));
});

describe("classifyFreq3Fast — 3점 빈도", () => {
  it.each([
    ["거의 없어", 1], ["전혀 안 그래", 1],
    ["가끔 그렇지", 2], ["어쩌다 한 번씩", 2],
    ["자주 그래", 3], ["맨날 그렇지", 3],
  ])("'%s' → %d", (a, e) => expect(classifyFreq3Fast(a as string)).toBe(e));
});

describe("classifyFast — 빈도 응답 정규식 분류", () => {
  it.each([
    ["전혀 없었어", 0], ["그런 적 없어", 0], ["아니야", 0], ["괜찮았어", 0],
    ["며칠 그랬지", 1], ["가끔 그래", 1], ["한두 번 있었나", 1],
    ["절반은 넘는 것 같아", 2], ["자주 그랬어", 2],
    ["거의 매일 그래", 3], ["맨날 그렇지 뭐", 3],
  ])("'%s' → %d", (answer, expected) => {
    expect(classifyFast(answer as string)).toBe(expected);
  });
  it("모호한 답은 -1 (LLM 위임)", () => {
    expect(classifyFast("글쎄, 요즘 날씨가 더워서 그런가")).toBe(-1);
    expect(classifyFast("")).toBe(-1);
  });
  it("강한 빈도가 약한 빈도에 우선 ('거의 매일'에 '며칠' 미오인)", () => {
    expect(classifyFast("며칠이 뭐야, 거의 매일 그랬지")).toBe(3);
  });
});

describe("interpretPHQ9 — 표준 컷오프", () => {
  it.each([
    [0, "정상"], [4, "정상"], [5, "가벼운 수준"], [9, "가벼운 수준"],
    [10, "중간 수준"], [14, "중간 수준"], [15, "다소 심한 수준"], [19, "다소 심한 수준"],
    [20, "심한 수준"], [27, "심한 수준"],
  ])("%d점 → %s", (total, severity) => {
    expect(interpretPHQ9(total as number).severity).toBe(severity);
  });
  it("10점 이상은 전문가 상담 권고", () => {
    expect(interpretPHQ9(9).recommend).toBe(false);
    expect(interpretPHQ9(10).recommend).toBe(true);
  });
});
