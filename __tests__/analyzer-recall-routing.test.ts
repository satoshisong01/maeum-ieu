/**
 * 분석기 라우팅 — **자발적 회상** 턴은 정밀 채점(primary)으로 간다 (B1, 2026-10-06 직접 운전).
 *
 * 결함: 우회 표현으로 불러 준 단어를 어르신이 "아까 그 세 단어 뭐였더라? 하나도 생각이 안 나"라고 했는데,
 *   서버의 확인 턴 산술(5턴 주기) 밖이라 lite 1차 채점으로 갔고, 그 턴의 회상 실패가 기록되지 않았다.
 *   기억력 저하의 가장 직접적인 증거가 가장 싼 경로로 새던 것이다.
 *
 * 목 체제: @/lib/chat/llm의 getGenAI만(모델명 포획). 프롬프트·라우팅·파싱은 실제 코드.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const calledModels: string[] = [];
vi.mock("@/lib/chat/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/llm")>()),
  getGenAI: () => ({
    models: {
      generateContent: async (req: { model: string }) => {
        calledModels.push(req.model);
        return { text: JSON.stringify({ isAnomaly: false, analysisNote: "", cognitiveChecks: [] }) };
      },
    },
  }),
  logUsage: () => {},
}));

const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = "test-key";
afterAll(() => { if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = ORIGINAL_KEY; });

const { analyzeCognitive } = await import("@/lib/chat/cognitive-analyzer");

const REG = [
  "[방금] AI: 심심풀이로 하나 해볼까요? 하얀 백로 보니 셋이 사뿐 내려앉네요. 제가 부르면 할머니가 받아주세요. 백로, 옹기, 부삽.",
  "[방금] 사용자: 백로, 옹기, 부삽. 이렇게?",
  "[방금] AI: 맞아요 할머니, 정확하게 잘 하셨어요!",
].join("\n");
const LITE = "gemini-2.5-flash";

beforeEach(() => { calledModels.length = 0; });

describe("자발적 회상 턴 → 정밀 채점 직행", () => {
  it("불러 준 단어를 스스로 떠올리려는 턴은 lite를 거치지 않는다", async () => {
    await analyzeCognitive({
      userMessage: "근데 아까 그 세 단어 뭐였더라? 하나도 생각이 안 나.",
      assistantResponse: "괜찮아요, 천천히 떠올려 보셔요.",
      historyText: REG, envBlock: "",
    });
    // 🔒 2026-10-06 이전: 첫 호출이 lite였고, lite가 '이상 없음'이면 primary는 불리지도 않았다
    expect(calledModels[0]).toBeDefined();
    expect(calledModels[0]).not.toBe(LITE);
  });

  it("등록이 없는 대화의 같은 말은 평소대로 lite 1차", async () => {
    await analyzeCognitive({
      userMessage: "근데 아까 그 세 단어 뭐였더라? 하나도 생각이 안 나.",
      assistantResponse: "무슨 단어 말씀이세요?",
      historyText: "[방금] AI: 오늘 점심은 뭐 드셨어요?\n[방금] 사용자: 국수 먹었어", envBlock: "",
    });
    expect(calledModels[0]).toBe(LITE);
  });

  it("등록이 있어도 단어와 무관한 수다는 평소대로 lite 1차", async () => {
    await analyzeCognitive({
      userMessage: "오늘 날씨가 참 좋네",
      assistantResponse: "정말 그러네요!",
      historyText: REG, envBlock: "",
    });
    expect(calledModels[0]).toBe(LITE);
  });
});
