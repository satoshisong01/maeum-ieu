/**
 * 검진 평가 — 음성 선별 점수(29점)를 잠정 등급으로, 그리고 의사 보정(학력·시공간) 시 학력보정 등급으로 변환.
 *
 * ⚠️ 임상 정직성(조사 결과 반영):
 *  - 보건복지부 CIST 공식 절단점은 연령×학력 규준표(M-1.5SD)이며 저작권 매뉴얼에만 있어 공개 출처에 정확한 수치가 없다.
 *  - 따라서 이 모듈은 "공식 CIST 판정"이 아니라, MMSE-K 고정 절단점(24/20-23/19, 신뢰도 높음)을
 *    음성 29점 척도로 비율 보정한 **자체 잠정 선별 지표**다. 진단이 아니라 "재검·정밀검사 권유" 목적.
 *  - 임계값은 상수로 분리 — 추후 NID 공식 규준표 입수 시 이 상수만 교체.
 */
import { VOICE_MAX_POINTS } from "./cist-bank";

export const EXAM_VOICE_MAX = VOICE_MAX_POINTS; // 29 (시공간 2점 제외)
export const EXAM_FULL_MAX = EXAM_VOICE_MAX + 2; // 31 (의사가 시공간 입력 시)

// MMSE-K 비율(정상 하한 ≈0.83 / 치매 의심 상한 ≈0.62)을 음성 29점 척도로 적용 — 추후 규준표로 교체 가능.
export const NORMAL_RATIO = 24 / 29;   // ≈0.828 이상 = 정상범위
export const IMPAIRED_RATIO = 18 / 29; // ≈0.621 이하 = 저하 의심 (그 사이는 경계)

// 평가에 필요한 최소 답변 커버리지(무응답이 많으면 점수가 무의미 → 자료부족).
export const COVERAGE_MIN_RATIO = 0.6; // 영역의 60% 이상 실제 응답해야 평가

export type ExamBand = "정상범위" | "경계" | "저하의심" | "자료부족";

export interface ExamEval {
  band: ExamBand;
  label: string;       // 화면 표시 라벨
  advice: string;      // 권고 문구
  provisional: boolean; // 항상 true(공식 판정 아님)
}

const DISCLAIMER = "※ 보건복지부 공식 CIST 절단점이 아닌, 시공간 항목을 제외한 자체 음성 선별 지표입니다. 정확한 판정은 대면 검사로 확인하세요.";
export const EXAM_DISCLAIMER = DISCLAIMER;

function bandFromRatio(ratio: number): ExamBand {
  if (ratio >= NORMAL_RATIO) return "정상범위";
  if (ratio <= IMPAIRED_RATIO) return "저하의심";
  return "경계";
}

function evalFor(band: ExamBand): ExamEval {
  switch (band) {
    case "정상범위": return { band, label: "정상범위(잠정)", advice: "현재 별다른 인지저하 신호는 보이지 않습니다.", provisional: true };
    case "경계": return { band, label: "경계(잠정)", advice: "경계 범위입니다. 재검 또는 정밀검사를 권유합니다.", provisional: true };
    case "저하의심": return { band, label: "저하의심(잠정)", advice: "인지저하가 의심됩니다. 치매안심센터·의료기관 정밀검사를 권유합니다.", provisional: true };
    case "자료부족": return { band, label: "자료부족 — 평가 불가", advice: "무응답이 많아 평가할 수 없습니다. 추가 문진이 필요합니다.", provisional: true };
  }
}

/** 검진 답변 커버리지 — 평가 가능 여부. */
export function assessCoverage(answeredDomains: number, totalDomains: number): { ratio: number; sufficient: boolean } {
  const ratio = totalDomains > 0 ? answeredDomains / totalDomains : 0;
  return { ratio, sufficient: ratio >= COVERAGE_MIN_RATIO };
}

/** 잠정 등급 — 음성 점수만으로. 커버리지 부족이면 '자료부족'. */
export function classifyProvisional(score: number, max: number = EXAM_VOICE_MAX, sufficient: boolean = true): ExamEval {
  if (!sufficient) return evalFor("자료부족");
  const ratio = max > 0 ? score / max : 0;
  return evalFor(bandFromRatio(ratio));
}

// 학력 보정 — 저학력일수록 정상 규준이 낮으므로 위양성↓ 방향으로 약간의 가산점(보수적).
// 무학/문맹·초졸 이하에서 과다 의심을 줄이기 위한 잠정 보정(공식 규준표 입수 전).
export function educationBonus(educationYears: number | null | undefined): number {
  if (educationYears == null) return 0;
  if (educationYears <= 3) return 2;   // 무학·문맹
  if (educationYears <= 6) return 1;   // 초졸
  return 0;                            // 중졸 이상
}

/**
 * 학력보정 등급 — 의사가 학력 + 시공간(시계, 0~2)을 입력하면 더 정보가 풍부한 잠정 평가로 승급.
 * 여전히 공식 판정 아님(학력보정 잠정).
 */
export function classifyFormal(args: { voiceScore: number; visuospatial: number | null; educationYears: number | null; sufficient?: boolean }): ExamEval & { fullScore: number; fullMax: number } {
  const { voiceScore, visuospatial, educationYears, sufficient = true } = args;
  // 시공간 미입력이면 음성 29점 척도로 평가(분모 31 강제 시 정상 환자 강등되는 위양성 방지). 입력 시에만 31점.
  const hasVs = visuospatial != null;
  const fullScore = voiceScore + (hasVs ? Math.max(0, Math.min(2, visuospatial)) : 0);
  const fullMax = hasVs ? EXAM_FULL_MAX : EXAM_VOICE_MAX;
  const bonus = educationBonus(educationYears);
  if (!sufficient) return { ...evalFor("자료부족"), fullScore, fullMax };
  const ratio = (fullScore + bonus) / fullMax;
  const band = bandFromRatio(ratio);
  const base = evalFor(band);
  return { ...base, band, label: base.label.replace("(잠정)", "(학력보정 잠정)"), fullScore, fullMax };
}

/** 회차 비교 — 이전 대비 추세(개선/악화/유지). 점수 비율 차 ±0.07(≈2점) 기준. */
export function compareSessions(prevScore: number, prevMax: number, currScore: number, currMax: number): { direction: "개선" | "악화" | "유지"; deltaPct: number } {
  const pr = prevMax > 0 ? prevScore / prevMax : 0;
  const cr = currMax > 0 ? currScore / currMax : 0;
  const d = cr - pr;
  const deltaPct = Math.round(d * 100);
  if (d > 0.07) return { direction: "개선", deltaPct };
  if (d < -0.07) return { direction: "악화", deltaPct };
  return { direction: "유지", deltaPct };
}

export type TrendDirection = "개선" | "악화" | "유지" | "변동" | "부족";
export interface ExamTrend { direction: TrendDirection; label: string; detail: string }
const TREND_DELTA = 0.07; // 첫·끝 비율 차 임계(≈2점)
const TREND_VOLATILE = 0.12; // 등락 폭이 크면 '변동'

/**
 * 다회차 추세 요약 — series는 평가가능(자료충분) 회차의 {score,max}를 시간순(오래된→최신)으로.
 * 첫·끝 비율 차로 방향, 연속 단조성으로 '점진'·'변동'을 구분.
 */
export function summarizeExamTrend(series: { score: number; max: number }[]): ExamTrend {
  const ratios = series.filter((s) => s.max > 0).map((s) => s.score / s.max);
  const n = ratios.length;
  if (n < 2) return { direction: "부족", label: "추세 분석 대기", detail: "평가 가능한 검진이 2회 이상 쌓이면 추세를 보여드려요." };
  const first = ratios[0], last = ratios[n - 1];
  const delta = last - first;
  const diffs = ratios.slice(1).map((r, i) => r - ratios[i]);
  const spread = Math.max(...ratios) - Math.min(...ratios);
  const allDown = diffs.every((d) => d <= 0.02);
  const allUp = diffs.every((d) => d >= -0.02);
  const pct = Math.round(delta * 100);
  const recent = `최근 ${n}회 ${Math.round(first * 100)}%→${Math.round(last * 100)}% (${pct >= 0 ? "+" : ""}${pct}%p)`;
  if (delta < -TREND_DELTA) {
    return allDown
      ? { direction: "악화", label: "점진적 악화", detail: `${recent} · 회차마다 꾸준히 하락. 정밀검사·경과관찰 권유.` }
      : { direction: "악화", label: "전반적 악화(등락 있음)", detail: `${recent} · 등락은 있으나 전반 하락.` };
  }
  if (delta > TREND_DELTA) {
    return allUp
      ? { direction: "개선", label: "개선 추세", detail: `${recent} · 회차마다 상승.` }
      : { direction: "개선", label: "전반적 개선(등락 있음)", detail: `${recent} · 등락은 있으나 전반 상승.` };
  }
  if (spread > TREND_VOLATILE) return { direction: "변동", label: "변동 — 일관성 낮음", detail: `${recent} · 회차 간 등락 폭이 큼. 컨디션·검사환경 영향 가능, 반복 검사 권유.` };
  return { direction: "유지", label: "안정적 유지", detail: `${recent} · 큰 변화 없이 유지.` };
}
