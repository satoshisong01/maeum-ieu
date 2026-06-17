/**
 * 인지 선별 등급 산식 — computeOverallAvg / classifySeverity / detectAcuteChange.
 * CDR 등급·보호자 악화 알림 트리거의 단일 출처(lib/health/severity.ts) 결정적 검증.
 */
import { describe, it, expect } from "vitest";
import {
  computeOverallAvg, classifySeverity, detectAcuteChange,
  TIER_BOUNDS, PER_DOMAIN_WEIGHT_CAP, RISK_DOMAIN_THRESHOLD,
} from "@/lib/health/severity";

describe("computeOverallAvg — 영역 가중 평균", () => {
  it("평가 없으면 -1", () => {
    expect(computeOverallAvg([])).toBe(-1);
    expect(computeOverallAvg([{ avg_score: 0, count: 0 }])).toBe(-1);
  });
  it("단일 영역은 그 평균 그대로", () => {
    expect(computeOverallAvg([{ avg_score: 1.2, count: 5 }])).toBeCloseTo(1.2, 5);
  });
  it("건수로 가중 평균", () => {
    // (0*2 + 2*8)/(2+8) = 16/10 = 1.6
    expect(computeOverallAvg([{ avg_score: 0, count: 2 }, { avg_score: 2, count: 8 }])).toBeCloseTo(1.6, 5);
  });
  it("영역당 가중 상한(PER_DOMAIN_WEIGHT_CAP) 적용 — 한 영역 발화량이 지배 못 함", () => {
    // count 100은 15로 캡 → (0*15 + 2*15)/(15+15) = 1.0 (캡 없으면 0에 가까워짐)
    const capped = computeOverallAvg([{ avg_score: 0, count: 100 }, { avg_score: 2, count: 15 }]);
    expect(capped).toBeCloseTo(1.0, 5);
    expect(PER_DOMAIN_WEIGHT_CAP).toBe(15);
  });
});

describe("classifySeverity — 4단계 등급 경계", () => {
  it("평가전(-1)", () => expect(classifySeverity(-1).tier).toBe("평가전"));
  it.each([
    [0, "정상"], [0.29, "정상"],
    [0.3, "경증"], [0.79, "경증"],
    [0.8, "중증"], [1.49, "중증"],
    [1.5, "고위험"], [2.0, "고위험"],
  ])("avg %d → %s", (avg, tier) => {
    expect(classifySeverity(avg as number).tier).toBe(tier);
  });
  it("경계값이 TIER_BOUNDS와 일치", () => {
    expect(classifySeverity(TIER_BOUNDS.normal).tier).toBe("경증");   // 0.3 = 경증 시작
    expect(classifySeverity(TIER_BOUNDS.mild).tier).toBe("중증");     // 0.8 = 중증 시작
    expect(classifySeverity(TIER_BOUNDS.moderate).tier).toBe("고위험"); // 1.5 = 고위험 시작
  });
  it("중증 이상은 안내문에 전문의 상담 포함", () => {
    expect(classifySeverity(0.9).text).toContain("전문의");
    expect(classifySeverity(1.6).text).toContain("전문의");
  });
});

describe("detectAcuteChange — 최근 vs 베이스라인 추세", () => {
  it("자료 부족(각 윈도우 3건 미만)이면 자료부족", () => {
    expect(detectAcuteChange({ recentAvg: 1, recentCount: 2, baselineAvg: 0, baselineCount: 10 }).status).toBe("자료부족");
    expect(detectAcuteChange({ recentAvg: 1, recentCount: 10, baselineAvg: 0, baselineCount: 2 }).status).toBe("자료부족");
    expect(detectAcuteChange({ recentAvg: -1, recentCount: 10, baselineAvg: 0, baselineCount: 10 }).status).toBe("자료부족");
  });
  it("급성악화: delta>=0.7 이고 recentAvg>=0.8", () => {
    const r = detectAcuteChange({ recentAvg: 1.0, recentCount: 5, baselineAvg: 0.2, baselineCount: 8 });
    expect(r.status).toBe("급성악화");
    expect(r.text).toContain("빠른 진료");
  });
  it("악화: delta>=0.3 (급성 조건 미달)", () => {
    // delta=0.4, recentAvg=0.5(<0.8) → 급성 아님, 악화
    expect(detectAcuteChange({ recentAvg: 0.5, recentCount: 5, baselineAvg: 0.1, baselineCount: 5 }).status).toBe("악화");
  });
  it("개선: delta<=-0.3", () => {
    expect(detectAcuteChange({ recentAvg: 0.2, recentCount: 5, baselineAvg: 0.7, baselineCount: 5 }).status).toBe("개선");
  });
  it("안정: 변화 작음", () => {
    expect(detectAcuteChange({ recentAvg: 0.5, recentCount: 5, baselineAvg: 0.45, baselineCount: 5 }).status).toBe("안정");
  });
  it("RISK_DOMAIN_THRESHOLD 상수 노출(주의영역 표기 기준)", () => {
    expect(RISK_DOMAIN_THRESHOLD).toBe(1.0);
  });
});
