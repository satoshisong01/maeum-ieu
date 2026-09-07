/**
 * 계정 역할(screeningMode) 공통 정의 — 4종.
 *   user     : 어르신 본인 (대화만, 결과 비공개)
 *   pro      : 의사·전문가 (검진 시행 + 상세 평가내역 전체 열람)
 *   guardian : 보호자·가족 (결과 요약 + 알림만, 상세 평가내역 비공개)
 *   general  : 일반인 (본인 마음 건강 자가점검, 결과치만)
 */
export type ScreeningMode = "user" | "pro" | "guardian" | "general";

/** 문자열을 4종 중 하나로 정규화 (미상/구값 → user) */
export function normalizeMode(mode: string | null | undefined): ScreeningMode {
  return mode === "pro" || mode === "guardian" || mode === "general" ? mode : "user";
}

/** 환자 데이터 열람 권한이 있는 역할(의사·보호자). 그 외 null. */
export type ViewerRole = "pro" | "guardian";
export function resolveViewerRole(mode: string | null | undefined): ViewerRole | null {
  return mode === "pro" ? "pro" : mode === "guardian" ? "guardian" : null;
}

/** 상세 평가내역(문항별 채점·문답 원문·임상 근거)을 볼 수 있는가 = 의사(pro)만 */
export function canViewClinicalDetail(mode: string | null | undefined): boolean {
  return mode === "pro";
}
