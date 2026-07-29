/**
 * 화자 성문 공유 상수 — 클라이언트(추출)·서버(대조) 양쪽에서 사용(서버가 client 모듈 import 안 하도록 분리).
 */
export const VOICEPRINT_MODEL_ID = "wespeaker-resnet34-q8";
// 본인 판정 하한 — PoC 실측(본인 유사도 ≥0.85 / 타인 ≤0.58) 사이의 보수적 지점.
// 실제 노인 음성·소음 검증 후 조정 예정(현재는 테스트용 기본값).
export const VOICEPRINT_THRESHOLD = 0.55;
export const VOICEPRINT_DIM = 256;
