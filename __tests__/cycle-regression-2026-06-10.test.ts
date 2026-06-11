/**
 * 2026-06-10 60턴 사이클(스크립트 30 + 실시간 30)에서 발견된 결함 회귀 고정.
 * 1) normalizeHonorific이 3인칭 "이름+선생님"을 사용자 호칭으로 치환 ("김구 선생님은"→"김구 할머니은")
 * 2) stripReasoningTrace가 한국어 사고 라벨 "(생각) …"을 통과시킴
 * 3) profile-extractor가 "막내아들은 준호야"(은/는 조사)를 미매칭 → 한 문장 복수 가족에서 뒤 가족 누락
 */
import { describe, it, expect } from "vitest";
import { normalizeHonorific } from "@/lib/chat/postprocess";
import { stripReasoningTrace } from "@/lib/chat/llm";
import { RELATION_PATTERNS, cleanName } from "@/lib/chat/profile-extractor";
import { detectInappropriate } from "@/lib/chat/moderation";

describe("normalizeHonorific — 3인칭 이름+직함 보존 (2026-06-10 사이클 fix)", () => {
  it("이름 뒤 '선생님'은 3인칭 지칭이므로 치환하지 않는다", () => {
    const out = normalizeHonorific("김구 선생님은 아주 훌륭한 분이세요.", "할머니");
    expect(out).toContain("김구 선생님은");
    expect(out).not.toContain("할머니은");
  });
  it("사용자 직접 호칭 '선생님은'은 치환하되 조사를 받침에 맞게 교정한다", () => {
    const out = normalizeHonorific("선생님은 오늘 어떠세요?", "할머니");
    expect(out).toBe("할머니는 오늘 어떠세요?");
  });
  it("'선생님이' → '할머니가' (이/가 교정)", () => {
    const out = normalizeHonorific("선생님이 좋아하시는 노래예요.", "할머니");
    expect(out).toBe("할머니가 좋아하시는 노래예요.");
  });
  it("조사 없는 호격 '선생님,'은 그대로 치환된다", () => {
    const out = normalizeHonorific("선생님, 점심 드셨어요?", "할머니");
    expect(out).toBe("할머니, 점심 드셨어요?");
  });
  it("받침 있는 호칭(선생님 유지 사용자)으로의 교정도 정상", () => {
    // userHonorific이 받침으로 끝나는 경우(예: 어르신… TITLE에 포함되어 filter됨) 대신 '아드님'류 미존재 — 아빠로 검증
    const out = normalizeHonorific("회원님은 건강하세요?", "아빠");
    expect(out).toBe("아빠는 건강하세요?");
  });

  // ── 2026-06-11 적대적 리뷰 발견 회귀 고정 ──
  it("받침 무관 조사(께서/도/만/한테)도 치환된다 (HEAD 동작 복원)", () => {
    expect(normalizeHonorific("어르신께서는 정말 대단하세요.", "할머니")).toContain("할머니께서는");
    expect(normalizeHonorific("회원님도 한번 해보세요.", "할머니")).toBe("할머니도 한번 해보세요.");
    expect(normalizeHonorific("사장님한테 말씀하셨어요?", "할머니")).toBe("할머니한테 말씀하셨어요?");
    expect(normalizeHonorific("어르신만 믿어요.", "할머니")).toBe("할머니만 믿어요.");
  });
  it("인사말 뒤 호격은 치환된다 ('안녕하세요 선생님!')", () => {
    expect(normalizeHonorific("안녕하세요 선생님!", "할머니")).toBe("안녕하세요 할머니!");
    expect(normalizeHonorific("안녕하세요 선생님, 식사하셨어요?", "할머니")).toBe("안녕하세요 할머니, 식사하셨어요?");
    expect(normalizeHonorific("네 선생님~", "할머니")).toBe("네 할머니~");
  });
  it("개행 직후 호칭은 치환된다 (개행은 단어 연속 아님)", () => {
    expect(normalizeHonorific("잘하셨어요\n선생님은 정말 대단하세요.", "할머니")).toContain("할머니는");
  });
  it("'김구 선생님은' 3인칭은 여전히 보존된다", () => {
    expect(normalizeHonorific("김구 선생님은 훌륭한 분이세요.", "할머니")).toContain("김구 선생님은");
  });
});

describe("stripReasoningTrace — STT 사용자 발화 보호 (2026-06-11 리뷰 fix)", () => {
  it("isUserSpeech: 어르신 간접화법('~라고 한다')을 삭제하지 않는다", () => {
    const t = "오늘 병원에 갔다 왔어. 의사가 약을 바꾸라고 한다.";
    expect(stripReasoningTrace(t, { isUserSpeech: true })).toBe(t);
  });
  it("동반자 출력(기본)에서는 보고체 트레이스를 여전히 제거한다", () => {
    const out = stripReasoningTrace("할머니께서 증상이 나아지셨다고 한다. 정말 다행이에요.");
    expect(out).not.toContain("다고 한다");
    expect(out).toContain("다행이에요");
  });
});

describe("moderation — FN 복원 (2026-06-11 리뷰 fix)", () => {
  it("욕설 변형('야 꺼져', '꺼져버려', '제발 좀 꺼져')을 잡는다", () => {
    expect(detectInappropriate("야 꺼져").category).toBe("profanity");
    expect(detectInappropriate("아 꺼져버려").category).toBe("profanity");
    expect(detectInappropriate("제발 좀 꺼져").category).toBe("profanity");
  });
  it("사물 서술('TV가 꺼져버려서', '불이 꺼져 있어')은 여전히 통과", () => {
    expect(detectInappropriate("TV가 꺼져버려서 깜깜했어").category).toBe("ok");
    expect(detectInappropriate("불이 꺼져 있어서 놀랐네").category).toBe("ok");
  });
  it("속어 정칙형('떡을 치고')은 잡고 음식('떡을 먹었지')은 통과", () => {
    expect(detectInappropriate("떡을 치고 싶다").category).toBe("sexual");
    expect(detectInappropriate("아침에 떡을 먹었지 맛있더라").category).toBe("ok");
  });
});

describe("stripReasoningTrace — 한국어 사고 라벨/보고체 (2026-06-10 사이클 fix)", () => {
  it("'(생각) …' 선두 라벨과 보고체 문장을 제거한다", () => {
    const out = stripReasoningTrace("(생각) 할머니께서 어지럽고 메스꺼웠던 증상이 물이랑 떡을 드시고 나아지셨다고 한다. 할머니, 시원한 물이랑 떡을 드시고 좀 나아지셨다니 정말 다행이에요.");
    expect(out).not.toContain("(생각)");
    expect(out).not.toContain("다고 한다");
    expect(out).toContain("정말 다행이에요");
  });
  it("'생각: ' 콜론 라벨도 제거한다 (라벨만 — 평서체 잔여 문장 제거는 오삭제 위험으로 미적용)", () => {
    const out = stripReasoningTrace("생각: 사용자가 피곤해 보임. 할머니, 오늘은 푹 쉬세요.");
    expect(out).not.toContain("생각:");
    expect(out).toContain("푹 쉬세요");
  });
  it("정상 발화 '생각해보니…'는 보존한다", () => {
    const text = "생각해보니 오늘이 장날이네요. 할머니, 시장 구경 가실래요?";
    expect(stripReasoningTrace(text)).toBe(text);
  });
  it("속담 인용('천 리 간다')은 보고체로 오인하지 않는다", () => {
    const text = "발 없는 말이 천 리 간다는 속담처럼 소문은 빨리 퍼져요.";
    expect(stripReasoningTrace(text)).toBe(text);
  });
});

describe("profile-extractor — 한 문장 복수 가족 (2026-06-10 사이클 fix)", () => {
  const extractAll = (msg: string): Array<{ relation: string; name: string }> => {
    const found: Array<{ relation: string; name: string }> = [];
    for (const { pattern, relation } of RELATION_PATTERNS) {
      const m = msg.match(pattern);
      if (m && m[1]) found.push({ relation, name: cleanName(m[1]) });
    }
    return found;
  };

  it("'큰딸은 영숙이고 막내아들은 준호야'에서 두 가족 모두 매칭된다", () => {
    const found = extractAll("우리 큰딸은 영숙이고 막내아들은 준호야 다들 효자효녀지");
    const names = found.map((f) => f.name);
    expect(names).toContain("영숙");
    expect(names).toContain("준호");
  });
  it("'막내아들은 준호야' 단독(은/는 조사)도 매칭된다", () => {
    const found = extractAll("우리 막내아들은 준호야");
    expect(found.some((f) => f.relation === "son" && f.name === "준호")).toBe(true);
  });
  it("기존 '막내아들이 준호야'(이/가 조사)도 여전히 매칭된다", () => {
    const found = extractAll("우리 막내아들이 준호야");
    expect(found.some((f) => f.relation === "son" && f.name === "준호")).toBe(true);
  });
  it("이름이 '은'으로 시작해도 조사로 오인하지 않는다 (막내아들 은수야 → 은수)", () => {
    const found = extractAll("우리 막내아들 은수야");
    expect(found.some((f) => f.relation === "son" && f.name === "은수")).toBe(true);
  });
});
