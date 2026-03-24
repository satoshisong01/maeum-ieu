import { describe, it, expect } from "vitest";
import { parseGeminiResponse } from "@/lib/chat/parser";

describe("parseGeminiResponse", () => {
  it("정상 JSON 응답을 파싱한다", () => {
    const raw = '{"text": "안녕하세요", "isAnomaly": false, "analysisNote": ""}';
    const result = parseGeminiResponse(raw);
    expect(result.text).toBe("안녕하세요");
    expect(result.isAnomaly).toBe(false);
    expect(result.analysisNote).toBeNull();
  });

  it("```json 코드 블록을 파싱한다", () => {
    const raw = '```json\n{"text": "좋은 아침이에요", "isAnomaly": false, "analysisNote": ""}\n```';
    const result = parseGeminiResponse(raw);
    expect(result.text).toBe("좋은 아침이에요");
  });

  it("transcription 필드를 추출한다", () => {
    const raw = '{"transcription": "오늘 뭐 먹었어", "text": "점심은 드셨나요?", "isAnomaly": false, "analysisNote": ""}';
    const result = parseGeminiResponse(raw);
    expect(result.transcription).toBe("오늘 뭐 먹었어");
    expect(result.text).toBe("점심은 드셨나요?");
  });

  it("isAnomaly=true일 때 analysisNote를 반환한다", () => {
    const raw = '{"text": "정말요?", "isAnomaly": true, "analysisNote": "날씨 인지 오류"}';
    const result = parseGeminiResponse(raw);
    expect(result.isAnomaly).toBe(true);
    expect(result.analysisNote).toBe("날씨 인지 오류");
  });

  it("analysisNote를 500자로 잘라낸다", () => {
    const longNote = "가".repeat(600);
    const raw = `{"text": "응답", "isAnomaly": true, "analysisNote": "${longNote}"}`;
    const result = parseGeminiResponse(raw);
    expect(result.analysisNote).toHaveLength(500);
  });

  it("JSON이 아닌 일반 텍스트는 그대로 text에 담는다", () => {
    const raw = "안녕하세요, 오늘 날씨가 좋네요.";
    const result = parseGeminiResponse(raw);
    expect(result.text).toBe(raw);
    expect(result.isAnomaly).toBe(false);
  });

  it("JSON 앞뒤에 불필요한 텍스트가 있어도 파싱한다", () => {
    const raw = '응답입니다:\n{"text": "산책 가셨나요?", "isAnomaly": false, "analysisNote": ""}\n끝';
    const result = parseGeminiResponse(raw);
    expect(result.text).toBe("산책 가셨나요?");
  });
});
