/**
 * 인지 선별 종합 위험도 등급 판정 (순수 함수 — 테스트/재사용 가능).
 *
 * 영역별 평균 점수(0~2)를 가중 평균(overallAvg)한 뒤 4단계로 분류한다.
 * 기준은 KDSQ-C/AD8 의심 임계 + CDR 단계 개념을 반영한 운영 정의.
 */

export type SeverityTier = "평가전" | "정상" | "경증" | "중증" | "고위험";

/** 영역 평균이 이 값 이상이면 "주의가 필요한 영역"으로 표기 */
export const RISK_DOMAIN_THRESHOLD = 1.0;

/** 등급 경계 (overallAvg 기준) */
export const TIER_BOUNDS = { normal: 0.3, mild: 0.8, moderate: 1.5 } as const;

export interface DomainStat {
  avg_score: number;
  count: number;
}

/** 한 영역의 발화량(count)이 전체 등급을 지배하지 못하도록 가중 상한.
 *  예: 일상 잡담이 많은 영역(score 0 다수)이 다른 영역의 이상 신호를 희석하는 것 방지. */
export const PER_DOMAIN_WEIGHT_CAP = 15;

/** 영역별 (평균, 건수)로 전체 가중 평균(영역당 가중 상한 적용). 평가 없으면 -1. */
export function computeOverallAvg(stats: DomainStat[]): number {
  const weighted = stats.map((d) => ({ avg: d.avg_score, w: Math.min(d.count, PER_DOMAIN_WEIGHT_CAP) }));
  const total = weighted.reduce((s, d) => s + d.w, 0);
  if (total <= 0) return -1;
  return weighted.reduce((s, d) => s + d.avg * d.w, 0) / total;
}

/** 종단 추세 — 최근 윈도우 vs 베이스라인(이전) 윈도우 비교. */
export type TrendStatus = "급성악화" | "악화" | "안정" | "개선" | "자료부족";
export interface TrendInput {
  recentAvg: number;     // 최근 윈도우 overallAvg (computeOverallAvg 결과)
  recentCount: number;   // 최근 윈도우 총 평가 건수
  baselineAvg: number;   // 이전(베이스라인) 윈도우 overallAvg
  baselineCount: number; // 베이스라인 윈도우 총 평가 건수
}

/**
 * 급성 악화 감지 — 장기 평균이 낮아도 "최근 급변"을 포착.
 * (30일 평균만 보면 "25일 정상 + 최근 5일 중증"을 놓치는 문제 해결)
 */
export function detectAcuteChange(t: TrendInput): { status: TrendStatus; delta: number; text: string } {
  if (t.recentCount < 3 || t.baselineCount < 3 || t.recentAvg < 0 || t.baselineAvg < 0) {
    return { status: "자료부족", delta: 0, text: "" };
  }
  const delta = Number((t.recentAvg - t.baselineAvg).toFixed(2));
  if (delta >= 0.7 && t.recentAvg >= 0.8) {
    return { status: "급성악화", delta, text: "최근 인지 점수가 평소 대비 급격히 악화되었습니다. 섬망 등 급성·가역적 원인 배제를 위해 빠른 진료를 권장합니다." };
  }
  if (delta >= 0.3) {
    return { status: "악화", delta, text: "최근 인지 점수가 평소보다 악화되는 추세입니다. 지속적인 모니터링을 권장합니다." };
  }
  if (delta <= -0.3) {
    return { status: "개선", delta, text: "최근 인지 점수가 평소보다 개선되었습니다." };
  }
  return { status: "안정", delta, text: "최근 인지 점수는 평소와 비슷하게 유지되고 있습니다." };
}

/** overallAvg → 4단계 등급 + 보호자 안내 문구 */
export function classifySeverity(overallAvg: number): { tier: SeverityTier; text: string } {
  if (overallAvg < 0) return { tier: "평가전", text: "" };
  if (overallAvg < TIER_BOUNDS.normal) return { tier: "정상", text: "전반적으로 정상 범위입니다." };
  if (overallAvg < TIER_BOUNDS.mild) return { tier: "경증", text: "경미한 인지 변화가 관찰되므로 지속적인 모니터링을 권장합니다." };
  if (overallAvg < TIER_BOUNDS.moderate) return { tier: "중증", text: "인지 저하 가능성이 있으므로 전문의 상담을 권장합니다." };
  return { tier: "고위험", text: "심각한 인지 저하가 의심되므로 즉시 전문의 상담이 필요합니다." };
}
