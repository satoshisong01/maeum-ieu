/**
 * 한국어 조사·이름 후처리 단위 테스트.
 *
 * 왜 이 파일인가: `korean-particle.ts`는 이 저장소에서 **F2(死 정규식) 사고가 가장 많이 난 곳**이다.
 *   ASCII `\b`가 한글에 무력해 정규화가 통째로 죽었던 적(normalizeImnida),
 *   greedy가 조사를 흡수해 정답이 누출된 적(stripRecallAnswerLeak), 둘 다 여기서 났다.
 *   그런데 2026-10-02 커버리지 측정 시점에 분기 65.2%(30/46)로, 16개 분기가 미실행이었다.
 *
 * 이 모듈의 실패는 **조용하다.** 조사가 어색해지거나 정답이 새도 예외가 나지 않는다.
 *   특히 stripRecallAnswerLeak이 뚫리면 회상 정답이 어르신에게 노출되고, 어르신이 그걸 읽어
 *   답하면 분석기가 만점으로 채점한다 = 기억 저하를 놓치는 **위음성**.
 */
import { describe, it, expect } from "vitest";
import {
  hasJongseong, familiarName, nameSubj, nameTopic, nameObj, nameAlso,
  eunNeun, iGa, eulReul, gwaWa, normalizeImnida, fixFamiliarNameParticles, stripRecallAnswerLeak,
} from "@/lib/chat/korean-particle";

describe("받침 판정 (hasJongseong) — 모든 조사 선택의 기반", () => {
  it.each([["수진", true], ["영민", true], ["진우", false], ["수지", false], ["민지", false], ["김밥", true]])(
    "%s → %s", (w, expected) => expect(hasJongseong(w as string)).toBe(expected));

  it("한글이 아닌 끝 글자는 false (영문·숫자·기호)", () => {
    for (const w of ["John", "A1", "수진!", "민지?", "테스트 "]) expect(hasJongseong(w)).toBe(false);
  });

  it("빈 문자열은 false (throw 금지)", () => {
    expect(hasJongseong("")).toBe(false);
  });
});

describe("친근체 이름 — 받침 있으면 '이' 추가", () => {
  it("받침 있음: 수진 → 수진이", () => expect(familiarName("수진")).toBe("수진이"));
  it("받침 없음: 수지 → 수지 (그대로)", () => expect(familiarName("수지")).toBe("수지"));
  it("빈 값은 그대로", () => expect(familiarName("")).toBe(""));

  // 🔒 '이'가 붙은 뒤에는 받침이 없으므로 조사는 **항상** 가/는/를다.
  //    여기서 은/이/을이 나오면 "수진이은"처럼 깨진다.
  it("주격: 수진이가 / 수지가", () => {
    expect(nameSubj("수진")).toBe("수진이가");
    expect(nameSubj("수지")).toBe("수지가");
  });
  it("주제: 수진이는 / 수지는", () => {
    expect(nameTopic("수진")).toBe("수진이는");
    expect(nameTopic("수지")).toBe("수지는");
  });
  it("목적: 수진이를 / 수지를", () => {
    expect(nameObj("수진")).toBe("수진이를");
    expect(nameObj("수지")).toBe("수지를");
  });
  it("또한: 수진이도 / 수지도", () => {
    expect(nameAlso("수진")).toBe("수진이도");
    expect(nameAlso("수지")).toBe("수지도");
  });
});

describe("일반 단어 조사", () => {
  it("은/는", () => { expect(eunNeun("밥")).toBe("밥은"); expect(eunNeun("김치")).toBe("김치는"); });
  it("이/가", () => { expect(iGa("밥")).toBe("밥이"); expect(iGa("김치")).toBe("김치가"); });
  it("을/를", () => { expect(eulReul("밥")).toBe("밥을"); expect(eulReul("김치")).toBe("김치를"); });
  it("과/와", () => { expect(gwaWa("밥")).toBe("밥과"); expect(gwaWa("김치")).toBe("김치와"); });
});

describe("normalizeImnida — 한글 경계 lookahead (과거 ASCII \\b로 死했던 지점)", () => {
  it("받침 없는 이름: 수지이에요 → 수지예요", () => {
    expect(normalizeImnida("저는 수지이에요")).toBe("저는 수지예요");
  });

  it("받침 있는 이름: 이에요 유지", () => {
    expect(normalizeImnida("저는 수진이에요")).toBe("저는 수진이에요");
  });

  it("문장 끝에서도 동작한다 — 🔒 ASCII \\b면 여기서 실패했다", () => {
    expect(normalizeImnida("민지이에요")).toBe("민지예요");
  });

  it("구두점·공백 뒤에서도 동작", () => {
    expect(normalizeImnida("안녕하세요, 민지이에요.")).toBe("안녕하세요, 민지예요.");
  });

  it("뒤에 한글이 이어지면 건드리지 않는다 (오탐 방지)", () => {
    const t = "민지이에요라고 적혀 있었다";
    expect(normalizeImnida(t)).toBe(t);
  });

  it("'이예요' 변형도 정규화", () => {
    expect(normalizeImnida("민지이예요")).toBe("민지예요");
  });

  it("빈 입력은 그대로", () => expect(normalizeImnida("")).toBe(""));
});

describe("fixFamiliarNameParticles — LLM 조사 오류 정정", () => {
  it("받침 있는 이름의 잘못된 조사를 친근체로 교정", () => {
    expect(fixFamiliarNameParticles("지윤가 기억하고 있지요", "지윤")).toBe("지윤이가 기억하고 있지요");
    expect(fixFamiliarNameParticles("지윤는 어디 갔나", "지윤")).toBe("지윤이는 어디 갔나");
    expect(fixFamiliarNameParticles("지윤랑 이야기했어", "지윤")).toBe("지윤이랑 이야기했어");
    expect(fixFamiliarNameParticles("지윤를 봤어", "지윤")).toBe("지윤이를 봤어");
    expect(fixFamiliarNameParticles("지윤와 같이", "지윤")).toBe("지윤이와 같이");
  });

  it("호격 '야' → '아' (지윤야 → 지윤아)", () => {
    expect(fixFamiliarNameParticles("지윤야 밥 먹자", "지윤")).toBe("지윤아 밥 먹자");
  });

  it("이미 올바른 형태는 건드리지 않는다", () => {
    const t = "지윤이가 기억하고 있지요";
    expect(fixFamiliarNameParticles(t, "지윤")).toBe(t);
  });

  it("받침 없는 이름은 정정 대상이 아니다 (조기 반환)", () => {
    const t = "민지가 기억하고 있지요";
    expect(fixFamiliarNameParticles(t, "민지")).toBe(t);
  });

  it("이름이 다른 단어의 일부면 건드리지 않는다 — 🔒 lookbehind 경계", () => {
    const t = "박지윤가수가 나왔어";   // '지윤' 앞뒤가 한글
    expect(fixFamiliarNameParticles(t, "지윤")).toBe(t);
  });

  it("빈 text·빈 name은 그대로 (throw 금지)", () => {
    expect(fixFamiliarNameParticles("", "지윤")).toBe("");
    expect(fixFamiliarNameParticles("아무말", "")).toBe("아무말");
  });

  it("정규식 메타문자가 든 이름도 안전하다 (ReDoS·오매칭 방지)", () => {
    const t = "a.c가 왔어";
    // 이스케이프가 빠지면 '.'이 임의 문자로 매칭돼 엉뚱한 곳을 고친다
    expect(() => fixFamiliarNameParticles(t, "a.c")).not.toThrow();
  });
});

describe("stripRecallAnswerLeak — 회상 정답 노출 차단 (위음성 직결)", () => {
  it("빈 입력은 그대로", () => expect(stripRecallAnswerLeak("")).toBe(""));

  it("등록(지금 외울 단어 제시) 발화는 단어를 **지우지 않는다**", () => {
    const t = "세 가지 단어 말씀드릴게요. 나무, 자동차, 모자. 이따 여쭤볼게요";
    const out = stripRecallAnswerLeak(t);
    // 🔒 여기서 지워지면 어르신이 외울 단어를 못 듣는다(****이에요 버그)
    expect(out).toContain("나무");
    expect(out).toContain("모자");
  });

  it("따라 말하기 재요청도 등록 단계 — 단어 유지", () => {
    const t = "불러드린 단어 '나무', '자동차', '모자'를 따라 말씀해주시겠어요";
    expect(stripRecallAnswerLeak(t)).toContain("나무");
  });

  it("회상 요청에서 따옴표 정답 나열은 제거한다", () => {
    const out = stripRecallAnswerLeak("아까 외워드린 단어 기억나세요? '나무', '자동차', '모자'였는데");
    expect(out).not.toContain("나무");
    expect(out).not.toContain("모자");
  });

  it("과거형('말씀드렸죠')은 등록이 아니라 회상 — 정답을 제거한다", () => {
    // 🔒 2026-10-01 실측 2/7 FAIL의 바로 그 케이스. 과거형을 등록으로 보면 정답이 통째로 노출된다.
    const out = stripRecallAnswerLeak("단어 세 개 말씀드렸죠, 나무, 자동차, 모자. 기억나세요?");
    expect(out).not.toContain("자동차");
    expect(out).not.toContain("모자");
  });

  it("빠진 정답을 채워주는 단일 단어 노출도 제거", () => {
    const out = stripRecallAnswerLeak("외운 단어 중에 마지막 하나는 '모자'였어요. 기억나세요?");
    expect(out).not.toContain("모자");
  });

  it("회상 맥락이 아니면 일반 나열을 건드리지 않는다 (오탐 방지)", () => {
    const t = "오늘 시장에서 사과, 배추, 두부를 샀어요";
    expect(stripRecallAnswerLeak(t)).toContain("배추");
  });

  it("정답 제거 후 비문을 남기지 않는다", () => {
    const out = stripRecallAnswerLeak("아까 외워드린 단어 세 개는 '나무', '자동차', '모자'였는데 기억나세요?");
    // 🔒 "단어 세 개는 ." 같은 잔여가 남으면 TTS가 어색하게 읽는다
    expect(out).not.toMatch(/는\s*\.|,\s*\./);
    expect(out.trim()).not.toMatch(/\s{2,}/);
  });
});
