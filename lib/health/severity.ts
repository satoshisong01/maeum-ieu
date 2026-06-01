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

/** 영역별 (평균, 건수)로 전체 가중 평균. 평가 없으면 -1. */
export function computeOverallAvg(stats: DomainStat[]): number {
  const total = stats.reduce((s, d) => s + d.count, 0);
  if (total <= 0) return -1;
  return stats.reduce((s, d) => s + d.avg_score * d.count, 0) / total;
}

/** overallAvg → 4단계 등급 + 보호자 안내 문구 */
export function classifySeverity(overallAvg: number): { tier: SeverityTier; text: string } {
  if (overallAvg < 0) return { tier: "평가전", text: "" };
  if (overallAvg < TIER_BOUNDS.normal) return { tier: "정상", text: "전반적으로 정상 범위입니다." };
  if (overallAvg < TIER_BOUNDS.mild) return { tier: "경증", text: "경미한 인지 변화가 관찰되므로 지속적인 모니터링을 권장합니다." };
  if (overallAvg < TIER_BOUNDS.moderate) return { tier: "중증", text: "인지 저하 가능성이 있으므로 전문의 상담을 권장합니다." };
  return { tier: "고위험", text: "심각한 인지 저하가 의심되므로 즉시 전문의 상담이 필요합니다." };
}
