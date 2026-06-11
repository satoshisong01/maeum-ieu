import { describe, it, expect } from "vitest";
import {
  removeParrot,
  removeTimeLabels,
  normalizeHonorific,
  fixChildGenderHonorific,
  normalizeFamilyChildHonorific,
  removeUngroundedClaims,
  fixWordChainStart,
  removeRepeatedOpening,
  trimIncomplete,
  postProcessReply,
} from "@/lib/chat/postprocess";

describe("removeTimeLabels", () => {
  it("[방금] 라벨을 제거한다", () => {
    expect(removeTimeLabels("[방금] 안녕하세요, 할머니!")).toBe("안녕하세요, 할머니!");
  });

  it("[2시간 전] 같은 숫자+단위 라벨을 제거한다", () => {
    expect(removeTimeLabels("[2시간 전] 점심 드셨다고 하셨죠?")).toBe("점심 드셨다고 하셨죠?");
  });

  it("문장 중간의 [3일 전] 라벨도 제거하고 공백을 정리한다", () => {
    expect(removeTimeLabels("지난번에 [3일 전] 산책 다녀오셨잖아요.")).toBe("지난번에 산책 다녀오셨잖아요.");
  });

  it("라벨이 없으면 그대로 둔다", () => {
    expect(removeTimeLabels("오늘 날씨가 좋네요.")).toBe("오늘 날씨가 좋네요.");
  });
});

describe("trimIncomplete", () => {
  it("종결 부호로 끝나면 그대로 둔다", () => {
    expect(trimIncomplete("오늘 날씨가 참 좋네요.")).toBe("오늘 날씨가 참 좋네요.");
  });

  it("끝이 잘린 문장은 마지막 완성 문장까지만 남긴다", () => {
    const complete = "오늘 점심은 맛있게 드셨다니 다행이고 산책까지 다녀오셨다니 정말 잘하셨습니다!";
    expect(trimIncomplete(`${complete} 내일 아침"`)).toBe(complete);
  });

  it("완성 부분이 절반 미만이면 자르지 않고 그대로 둔다", () => {
    const text = "네! 그런데 내일은 비가 온다고 하니까 우산을 꼭"; // '!'가 앞쪽 절반에 있음
    expect(trimIncomplete(text)).toBe(text);
  });
});

describe("normalizeFamilyChildHonorific", () => {
  it("'큰아들이 재미야' 문맥이면 '재미 씨가'의 '씨'를 제거한다", () => {
    expect(normalizeFamilyChildHonorific("재미 씨가 다녀가셨군요!", "큰아들이 재미야"))
      .toBe("재미가 다녀가셨군요!");
  });

  it("친근 종조사로 호명된 이름('수아랑'은 아님, '영민이가')에도 적용된다", () => {
    expect(normalizeFamilyChildHonorific("영민 씨도 건강하시죠?", "어제 영민이가 전화했어"))
      .toBe("영민도 건강하시죠?");
  });

  it("문맥에 호명 단서가 없으면 '씨'를 유지한다", () => {
    expect(normalizeFamilyChildHonorific("재미 씨가 다녀가셨군요!", "오늘 날씨 참 좋다"))
      .toBe("재미 씨가 다녀가셨군요!");
  });
});

describe("fixChildGenderHonorific", () => {
  it("DB에 딸로 저장된 이름의 '아드님'을 '따님'으로 정정한다", () => {
    expect(fixChildGenderHonorific("수진 아드님이 다녀가셨어요?", [{ name: "수진", relation: "daughter" }]))
      .toBe("수진 따님이 다녀가셨어요?");
  });

  it("DB에 아들로 저장된 이름의 '따님'을 '아드님'으로 정정한다", () => {
    expect(fixChildGenderHonorific("민호 따님은 잘 지내시죠?", [{ name: "민호", relation: "son" }]))
      .toBe("민호 아드님은 잘 지내시죠?");
  });

  it("프로필에 없어도 문맥의 '큰딸 영숙이가' 단서로 정정한다", () => {
    expect(fixChildGenderHonorific("영숙 아드님이 효녀네요.", [], "큰딸 영숙이가 김치를 가져왔어"))
      .toBe("영숙 따님이 효녀네요.");
  });

  it("성별 단서가 없으면 그대로 둔다", () => {
    expect(fixChildGenderHonorific("수진 아드님이 다녀가셨어요?", []))
      .toBe("수진 아드님이 다녀가셨어요?");
  });
});

describe("removeRepeatedOpening", () => {
  it("직전 AI 응답과 같은 첫 문장을 제거한다", () => {
    const opening = "오늘은 날씨가 참 좋아서 산책하기 딱 좋은 날이에요.";
    expect(removeRepeatedOpening(`${opening} 그런데 저녁은 뭐 드실 거예요?`, `${opening} 점심은 드셨어요?`))
      .toBe("그런데 저녁은 뭐 드실 거예요?");
  });

  it("짧은 동조 인사(12자 미만)는 반복이어도 그대로 둔다", () => {
    const text = "네, 알겠어요! 내일 또 이야기해요.";
    expect(removeRepeatedOpening(text, "네, 알겠어요! 푹 쉬세요.")).toBe(text);
  });

  it("첫 문장이 다르면 그대로 둔다", () => {
    const text = "저녁 반찬은 뭐가 좋을까요? 생선구이 어떠세요?";
    expect(removeRepeatedOpening(text, "오늘은 날씨가 참 좋아서 산책하기 딱 좋은 날이에요."))
      .toBe(text);
  });
});

describe("fixWordChainStart", () => {
  it("제시 단어('가방')의 끝글자가 아닌 시작글자 요청을 끝글자로 교정한다", () => {
    const out = fixWordChainStart("좋아요! 이번엔 '가방'이라고 할게요. '가'로 시작하는 단어를 말씀해 주세요!");
    expect(out).toContain("'방'");
    expect(out).not.toContain("'가'로 시작하는");
  });

  it("올바른 끝글자 요청은 그대로 둔다", () => {
    const text = "좋아요! 이번엔 '가방'이라고 할게요. '방'으로 시작하는 단어를 말씀해 주세요!";
    expect(fixWordChainStart(text)).toBe(text);
  });

  it("끝말잇기 제시 패턴이 없으면 그대로 둔다", () => {
    const text = "'가'로 시작하는 단어가 뭐가 있을까요?";
    expect(fixWordChainStart(text)).toBe(text);
  });
});

describe("removeParrot", () => {
  it("사용자 발화를 그대로 되풀이하는 앵무새 첫 문장을 제거한다", () => {
    const out = removeParrot(
      "된장찌개에 무랑 두부까지 넣어서 끓이셨다니 정말 맛있었겠어요! 저녁은 든든하게 드셨네요.",
      "된장찌개에 무랑 두부 넣어서 끓였어",
    );
    expect(out).toBe("저녁은 든든하게 드셨네요.");
  });

  it("정상 공감 응답은 그대로 둔다", () => {
    const text = "맛있게 드셨다니 좋네요! 저녁에는 뭐 드실 거예요?";
    expect(removeParrot(text, "된장찌개 끓여 먹었어")).toBe(text);
  });
});

describe("removeUngroundedClaims", () => {
  it("문맥에 없는 사실을 전제하는 문장을 제거한다", () => {
    const out = removeUngroundedClaims(
      "아까 병원에 다녀오셨다고 하셨는데 괜찮으세요? 오늘 점심은 드셨어요?",
      "오늘 점심 먹었어",
    );
    expect(out).toBe("오늘 점심은 드셨어요?");
  });

  it("전제 표현이 없는 문장은 그대로 둔다", () => {
    const text = "오늘 날씨가 참 좋네요! 산책 다녀오셨어요?";
    expect(removeUngroundedClaims(text, "응 그래")).toBe(text);
  });
});

describe("normalizeHonorific", () => {
  it("호격(쉼표 동반) 친족 호칭을 사용자 호칭으로 치환한다", () => {
    expect(normalizeHonorific("어머니, 식사는 하셨어요?", "할머니")).toBe("할머니, 식사는 하셨어요?");
  });

  it("3인칭 가족 지칭(호격 아님)은 보존한다", () => {
    const text = "꿈에서 어머니와 이야기하셨군요.";
    expect(normalizeHonorific(text, "할머니")).toBe(text);
  });

  it("존칭/직함('어머님')은 위치와 무관하게 치환한다", () => {
    expect(normalizeHonorific("어머님 덕분에 즐거웠어요.", "할머니")).toBe("할머니 덕분에 즐거웠어요.");
  });
});

describe("postProcessReply (파이프라인 스모크)", () => {
  const opts = { userText: "응 그래", companionName: "민지", ctx: "", honorific: "할머니", family: [], prevAi: "" };

  it("깨끗한 문장은 변형 없이 통과한다", () => {
    const text = "오늘 날씨가 참 좋네요. 산책 다녀오셨어요?";
    expect(postProcessReply(text, opts)).toBe(text);
  });

  it("시간 라벨 + 잘린 꼬리를 한 번에 정리한다", () => {
    const out = postProcessReply("[방금] 오늘 점심은 맛있게 드셨다니 다행이고 산책까지 다녀오셨다니 정말 잘하셨습니다! 내일 아침\"", opts);
    expect(out).toBe("오늘 점심은 맛있게 드셨다니 다행이고 산책까지 다녀오셨다니 정말 잘하셨습니다!");
  });
});
