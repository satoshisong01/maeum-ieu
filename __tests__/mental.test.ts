/** T3 정신건강 검진 — 질문지 무결성 + 응답 분류 fast-path + 해석 컷오프 */
import { describe, it, expect } from "vitest";
import { PHQ9_ITEMS, GAD7_ITEMS, SCALES, interpretPHQ9, interpretGAD7 } from "@/lib/screening/mental-bank";
import { classifyFast } from "@/lib/health/mental-scorer";

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
