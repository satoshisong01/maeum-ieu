import { describe, it, expect } from "vitest";
import { detectInappropriate } from "@/lib/chat/moderation";

describe("detectInappropriate — 일상 발화 false positive 방지", () => {
  it.each([
    "떡을 먹었지 맛있더라", // 음식 '떡' — 속어 활용형(치/쳐)만 매칭해야 함
    "불이 꺼져서 깜깜했어", // 사물 서술 '꺼져' — 욕설 아님
    "TV가 꺼져 있어",
  ])("'%s'는 ok로 통과한다", (text) => {
    expect(detectInappropriate(text).category).toBe("ok");
  });
});

describe("detectInappropriate — 욕설 감지", () => {
  it.each([
    "꺼져", // 발화 시작 '꺼져'는 욕설
    "너 꺼져", // 대상 지칭 '꺼져'
    "닥쳐",
    "씨발",
  ])("'%s'를 profanity로 감지한다", (text) => {
    expect(detectInappropriate(text).category).toBe("profanity");
  });
});

describe("detectInappropriate — 성적 표현 감지", () => {
  it.each([
    "떡치", // 속어 활용형
    "야동 보여줘",
  ])("'%s'를 sexual로 감지한다", (text) => {
    expect(detectInappropriate(text).category).toBe("sexual");
  });
});

describe("detectInappropriate — 자살·자해 감지", () => {
  it("'죽고 싶어'를 self_harm으로 감지한다", () => {
    expect(detectInappropriate("죽고 싶어").category).toBe("self_harm");
  });
});

describe("detectInappropriate — 빈 입력", () => {
  it("빈 문자열은 ok", () => {
    expect(detectInappropriate("").category).toBe("ok");
  });
});
