import { describe, it, expect } from "vitest";
import { classifyProvisional, classifyFormal, assessCoverage, compareSessions, summarizeExamTrend, educationBonus, EXAM_VOICE_MAX } from "./exam-eval";

describe("exam-eval 잠정 등급", () => {
  it("음성 만점은 정상범위", () => {
    expect(classifyProvisional(29).band).toBe("정상범위");
    expect(classifyProvisional(24).band).toBe("정상범위");
  });
  it("중간 점수는 경계", () => {
    expect(classifyProvisional(22).band).toBe("경계");
    expect(classifyProvisional(19).band).toBe("경계");
  });
  it("낮은 점수는 저하의심", () => {
    expect(classifyProvisional(18).band).toBe("저하의심");
    expect(classifyProvisional(3).band).toBe("저하의심");
    expect(classifyProvisional(0).band).toBe("저하의심"); // 응답은 했으나 다 틀린 경우
  });
  it("커버리지 부족이면 점수와 무관하게 자료부족", () => {
    expect(classifyProvisional(0, EXAM_VOICE_MAX, false).band).toBe("자료부족");
    expect(classifyProvisional(25, EXAM_VOICE_MAX, false).band).toBe("자료부족");
  });
});

describe("커버리지 판정", () => {
  it("60% 이상 응답해야 평가 가능", () => {
    expect(assessCoverage(7, 7).sufficient).toBe(true);
    expect(assessCoverage(5, 7).sufficient).toBe(true);  // ≈0.71
    expect(assessCoverage(4, 7).sufficient).toBe(false); // ≈0.57 < 0.6
  });
  it("무응답 과다는 자료부족", () => {
    expect(assessCoverage(3, 7).sufficient).toBe(false); // 0.43
    expect(assessCoverage(0, 7).sufficient).toBe(false);
  });
});

describe("학력 보정", () => {
  it("저학력일수록 가산점(위양성↓)", () => {
    expect(educationBonus(0)).toBe(2);
    expect(educationBonus(6)).toBe(1);
    expect(educationBonus(12)).toBe(0);
    expect(educationBonus(null)).toBe(0);
  });
  it("학력보정 등급은 시공간 포함 31점 + 보정", () => {
    const r = classifyFormal({ voiceScore: 18, visuospatial: 1, educationYears: 0 });
    expect(r.fullScore).toBe(19);
    expect(r.fullMax).toBe(31);
    expect(r.label).toContain("학력보정");
  });
  it("커버리지 부족이면 학력보정도 자료부족", () => {
    expect(classifyFormal({ voiceScore: 0, visuospatial: 0, educationYears: 6, sufficient: false }).band).toBe("자료부족");
  });
  it("시공간 미입력(null)이면 음성 29점 척도로 — 정상 환자 강등 안 함", () => {
    const r = classifyFormal({ voiceScore: 24, visuospatial: null, educationYears: 12 });
    expect(r.fullMax).toBe(29);
    expect(r.fullScore).toBe(24);
    expect(r.band).toBe("정상범위"); // 24/29 → 정상 (31분모면 0.774로 경계 강등됨)
  });
});

describe("회차 추세 비교", () => {
  it("점수가 오르면 개선", () => {
    expect(compareSessions(18, 29, 24, 29).direction).toBe("개선");
  });
  it("점수가 내리면 악화", () => {
    expect(compareSessions(24, 29, 18, 29).direction).toBe("악화");
  });
  it("비슷하면 유지", () => {
    expect(compareSessions(22, 29, 23, 29).direction).toBe("유지");
  });
});

describe("다회차 추세 요약", () => {
  const S = (n: number) => ({ score: n, max: 29 });
  it("2회 미만은 부족", () => {
    expect(summarizeExamTrend([S(25)]).direction).toBe("부족");
    expect(summarizeExamTrend([]).direction).toBe("부족");
  });
  it("꾸준히 하락하면 점진적 악화", () => {
    const t = summarizeExamTrend([S(26), S(22), S(18), S(14)]);
    expect(t.direction).toBe("악화");
    expect(t.label).toBe("점진적 악화");
  });
  it("꾸준히 상승하면 개선 추세", () => {
    const t = summarizeExamTrend([S(14), S(19), S(24)]);
    expect(t.direction).toBe("개선");
    expect(t.label).toBe("개선 추세");
  });
  it("큰 변화 없으면 안정 유지", () => {
    expect(summarizeExamTrend([S(24), S(25), S(24)]).direction).toBe("유지");
  });
  it("등락 폭이 크면 변동", () => {
    expect(summarizeExamTrend([S(26), S(14), S(25)]).direction).toBe("변동");
  });
});
