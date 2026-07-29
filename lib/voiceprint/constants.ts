/**
 * 화자 성문 공유 상수 — 클라이언트(추출)·서버(대조) 양쪽에서 사용(서버가 client 모듈 import 안 하도록 분리).
 */
export const VOICEPRINT_MODEL_ID = "wespeaker-resnet34-fp32";
// 본인 판정 하한. 합성 음성 PoC는 본인 0.85·타인 0.58이었으나, 실제 사람 목소리(등록 낭독 vs 테스트 잡담,
// 폰 마이크·소음)는 본인 유사도가 이보다 낮게 나옴 → 문헌상 wespeaker 코사인 검증 임계(0.25~0.4)에 맞춰 하향.
// 실기기 실측값(본인/타인 %)으로 최종 조정 예정.
export const VOICEPRINT_THRESHOLD = 0.35;
export const VOICEPRINT_DIM = 256;
