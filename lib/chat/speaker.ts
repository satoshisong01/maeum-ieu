/**
 * 화자 인증 / 라벨링 인프라.
 *
 * Phase 1 (현재):
 * - Message.speakerLabel 컬럼: "primary" | "visitor" | "unknown"
 * - 보호자 수동 라벨링 (대시보드에서 클릭으로 토글)
 * - cognitive_assessments 집계에서 visitor 라벨 메시지는 제외하는 헬퍼 제공
 *
 * Phase 2 (예정 — ML 모델 도입 후):
 * - 사용자 voiceprint 등록 (3-5초 발화 × 3회)
 * - 매 발화마다 음성 임베딩 추출 (ECAPA-TDNN 등)
 * - cosine similarity 비교 → speakerLabel 자동 할당
 * - 임계값 미만이면 'unknown'으로 마킹 → 보호자 검토 요청
 *
 * 현재 자동 판정은 wake-word 사용 환경의 약한 가정에 의존: 등록된 사용자만이
 * wake-word를 알고 있으므로 대화 시작자는 primary로 가정. 다만 응급/이상 발화는
 * 라벨이 null이면 보호자가 확인해 visitor로 표기할 수 있도록 함.
 */

export type SpeakerLabel = "primary" | "visitor" | "unknown";

export const SPEAKER_LABELS: SpeakerLabel[] = ["primary", "visitor", "unknown"];

export function isValidSpeakerLabel(value: unknown): value is SpeakerLabel {
  return typeof value === "string" && (SPEAKER_LABELS as string[]).includes(value);
}

/**
 * cognitive aggregation에서 사용할 SQL WHERE 절 — visitor 라벨 메시지 제외.
 * 메시지 ID 기준 join 없이 cognitive_assessments에 message_id가 있어야 함.
 *
 * NOTE: 현재 cognitive_assessments 스키마는 message_id를 보존하므로 join 가능.
 * 라벨이 null이면 unknown 취급 (집계 포함) — 명시적 visitor만 제외.
 */
export function buildVisitorExclusionJoinClause(messageTable = "\"Message\""): string {
  return `LEFT JOIN ${messageTable} m_speaker ON m_speaker.id = ca.message_id`;
}

export function buildVisitorExclusionWhere(): string {
  return `(m_speaker."speakerLabel" IS NULL OR m_speaker."speakerLabel" != 'visitor')`;
}

/**
 * 기본 라벨 추론 (Phase 1 휴리스틱):
 * - 응급/이상 발화가 아닌 일반 발화는 wake-word 사용 가정 하에 primary
 * - 응급/이상 발화는 null로 두고 보호자 검토 유도
 *
 * Phase 2에서는 voiceprint 비교 결과로 대체.
 */
export function inferInitialSpeakerLabel(opts: {
  isEmergency: boolean;
  isAnomaly: boolean;
}): SpeakerLabel | null {
  if (opts.isEmergency || opts.isAnomaly) return null; // 보호자 검토 유도
  return "primary";
}
