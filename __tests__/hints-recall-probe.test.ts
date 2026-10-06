/**
 * 동반자 힌트 — 회상 요청(B1·B4)과 확인 턴 보류(B3). 2026-10-06 직접 운전에서 나온 결함.
 *
 * B1·B4: 우회 표현으로 단어를 불러 준 뒤 어르신이 "아까 그 세 단어 뭐였더라?"라고 묻자, 힌트가 등록을 못 알아봐
 *   "외워드린 적이 없다"고 동반자에게 알렸고 동반자는 "혹시 어디서 다른 단어를 들으셨을까요?"라고 되물었다.
 *   동시에 정답을 말하려다 후처리에 잘려 "아까 불러드린 단어는." 같은 비문이 남았다.
 * B3: L2(누적 승격) 턴에 상태 확인과 인지 퀴즈가 한 응답에 섞였다.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { buildRecallVerificationHint, buildProbeHoldHint } from "@/lib/chat/hints";

const HISTORY_WITH_NATURAL_REGISTRATION = [
  "[방금] AI: 심심풀이로 재미 삼아 하나 해볼까요? 하얀 백로 보니 셋이 사뿐 내려앉네요. 제가 부르면 할머니가 받아주세요. 백로, 옹기, 부삽.",
  "[방금] 사용자: 백로, 옹기, 부삽. 이렇게?",
  "[방금] AI: 맞아요 할머니, 정확하게 잘 하셨어요!",
].join("\n");
const ASK = "근데 아까 그 세 단어 뭐였더라? 하나도 생각이 안 나. 좀 알려줘 봐.";

describe("회상 요청 힌트", () => {
  it("우회 표현으로 불러 준 단어도 '불러드린 것'으로 인정하고, 정답 대신 회상을 권한다", () => {
    const h = buildRecallVerificationHint(HISTORY_WITH_NATURAL_REGISTRATION, ASK, "민지");
    // 🔒 2026-10-06 이전: "이번 대화에서 민지가 단어를 외워드린 적이 한 번도 없습니다" → "어디서 들으셨어요?"
    expect(h).not.toMatch(/외워드린 적이 한 번도 없습니다/);
    expect(h).toMatch(/직접 불러드린 것이 맞습니다/);
    expect(h).toMatch(/단어를 알려주지 마세요/);
    expect(h).toMatch(/스스로 떠올려 보시게/);
  });

  it("정말로 불러 준 적이 없으면 여전히 환각을 막는다", () => {
    const h = buildRecallVerificationHint("[방금] AI: 오늘 점심은 뭐 드셨어요?\n[방금] 사용자: 국수 먹었어", ASK, "민지");
    expect(h).toMatch(/외워드린 적이 한 번도 없습니다/);
  });

  it.each(["아까 불러준 거 뭐였지?", "아까 그거 세 개 뭐였지?"])("다른 표현의 회상 요청도 잡는다: %s", (ask) => {
    expect(buildRecallVerificationHint(HISTORY_WITH_NATURAL_REGISTRATION, ask, "민지")).toMatch(/직접 불러드린 것이 맞습니다/);
  });

  it("회상 요청이 아니면 아무것도 넣지 않는다", () => {
    expect(buildRecallVerificationHint(HISTORY_WITH_NATURAL_REGISTRATION, "오늘 날씨 좋다", "민지")).toBe("");
  });
});

describe("확인 턴 보류 (B3)", () => {
  it.each([
    [true, 2, true],
    [true, 1, false],   // 단발 L1은 공감 뒤 확인 허용
    [true, 0, false],
    [false, 2, false],  // 확인 턴이 아니면 보류할 것도 없다
  ] as const)("probeTurn=%s · L%s → 보류 %s", (probe, level, hold) => {
    expect(buildProbeHoldHint(probe, level).length > 0).toBe(hold);
  });

  it("음성·텍스트 두 경로 모두 힌트 묶음에 넣는다", async () => {
    const src = await readFile("app/api/chat/route.ts", "utf-8");
    // 🔒 한 경로만 넣으면 실서비스(음성)에서 그대로 섞인다
    expect(src.match(/buildProbeHoldHint\(probeTurn, emergency\.effectiveLevel\),/g)?.length).toBe(2);
  });
});

describe("부모 지칭 힌트 (B5)", () => {
  it.each(["엄마가 해주던 호박죽이 생각나네", "우리 어머니는 콩국수를 잘 하셨어", "아버지가 늘 그러셨지", "친정엄마가 해줬어"])("부모 언급 → 힌트: %s", async (t) => {
    const { buildParentReferentHint } = await import("@/lib/chat/hints");
    expect(buildParentReferentHint(t, "할머니")).toMatch(/할머니 본인이 아닙니다/);
  });

  it.each(["우리 할아버지가 텃밭을 가꿨어", "오늘 날씨 좋다"])("부모 아님 → 없음: %s", async (t) => {
    const { buildParentReferentHint } = await import("@/lib/chat/hints");
    // 🔒 '할아버지'(배우자 호칭으로 흔함)의 '아버지'를 부모로 읽으면 엉뚱한 지시가 붙는다
    expect(buildParentReferentHint(t, "할머니")).toBe("");
  });
});

describe("일반인 자가점검 제안 힌트 (B7)", () => {
  it("마음 상태를 모르겠다는 말에 한 번 제안한다", async () => {
    const { buildMentalCheckOfferHint } = await import("@/lib/chat/hints");
    expect(buildMentalCheckOfferHint("general", "이게 우울한 건지 그냥 피곤한 건지 저도 모르겠어요.", "")).toMatch(/마음 건강 체크/);
  });

  it("이미 제안했거나 점검한 대화면 다시 권하지 않는다", async () => {
    const { buildMentalCheckOfferHint } = await import("@/lib/chat/hints");
    expect(buildMentalCheckOfferHint("general", "요즘 우울해요", "AI: 원하시면 '마음 건강 체크'를 같이 해볼 수 있어요.")).toBe("");
  });

  it.each(["user", "pro"])("%s 모드엔 없다 (모드 간 플로우 비혼합)", async (mode) => {
    const { buildMentalCheckOfferHint } = await import("@/lib/chat/hints");
    expect(buildMentalCheckOfferHint(mode, "요즘 우울해요", "")).toBe("");
  });
});

describe("새 힌트 배선 — 음성·텍스트 두 경로", () => {
  it("두 힌트 묶음에 부모 지칭·자가점검 제안이 모두 들어간다", async () => {
    const src = await readFile("app/api/chat/route.ts", "utf-8");
    expect(src.match(/buildParentReferentHint\((?:transcription|userContent), honorific\),/g)?.length).toBe(2);
    expect(src.match(/buildMentalCheckOfferHint\(mode, (?:transcription|userContent), historyText\),/g)?.length).toBe(2);
  });
});

describe("답 턴 채점 문장 제거 배선 (B6 잔여)", () => {
  it("음성·텍스트 두 경로 모두 후처리에 answeringProbe를 넘긴다", async () => {
    const src = await readFile("app/api/chat/route.ts", "utf-8");
    // 🔒 빠지면 답 턴에도 단계가 안 돌아 "정답이에요, 할머니!"가 그대로 나간다
    expect(src.match(/post: \{ userText: (?:transcription|userContent), companionName, ctx, honorific, family: profile\.family, prevAi, answeringProbe \},/g)?.length).toBe(2);
  });
});
