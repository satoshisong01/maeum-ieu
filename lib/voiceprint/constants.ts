/**
 * 화자 성문 공유 상수 — 클라이언트(추출)·서버(대조) 양쪽에서 사용(서버가 client 모듈 import 안 하도록 분리).
 */
export const VOICEPRINT_MODEL_ID = "wespeaker-resnet34-fp32";
// 본인 판정 하한. 실제 사람 5명 fp32 교차검증(2026-07-31): 본인 69~78% / 타인 최대 45%(대부분 3~31%),
// 분리마진 24%p. 그 사이 0.55로 설정 — 본인(≥0.69) 통과, 최근접 타인(0.45) 차단. 실사용은 표본 5+로
// 등록해 본인 점수가 더 높아지므로 여유. (q8→fp32 전환 전엔 임베딩 붕괴로 임계값 무의미했음)
export const VOICEPRINT_THRESHOLD = 0.55;
export const VOICEPRINT_DIM = 256;
