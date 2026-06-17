/**
 * 인지 등급 → 대화 적응 (폐루프 연결).
 *
 * 배경: cognitive_assessments 채점·severity 등급은 보호자 알림·전문가 대시보드·요약에만 쓰이고
 * 라이브 대화 프롬프트로는 한 번도 환류되지 않았음(측정→대화 폐루프 단절). 그 결과 중증으로 판정된
 * 어르신도 정상군과 동일한 길이·난이도 응답을 받아 따라오기 버거웠음(치매군 작동성 갭).
 *
 * 이 모듈은 severity 산식(severity.ts)과 집계 쿼리(cognitive-alert.fetchDomainStats)를 재사용해
 * buildSystemPrompt가 등급별 적응 지시를 주입하게 한다. 사용자 모드 전용.
 */
import { fetchDomainStats } from "@/lib/health/cognitive-alert";
import { computeOverallAvg, classifySeverity, type SeverityTier } from "@/lib/health/severity";

export interface CognitiveTierResult {
  tier: SeverityTier;
  avg: number;
}

/** 최근 30일 인지 평가로 종합 등급 산출. 평가 없거나 오류면 평가전(적응 미적용). */
export async function getCognitiveTierForPrompt(userId: string): Promise<CognitiveTierResult> {
  try {
    const stats = await fetchDomainStats(userId, 30, 0);
    const avg = computeOverallAvg(stats);
    return { tier: classifySeverity(avg).tier, avg };
  } catch {
    return { tier: "평가전", avg: -1 };
  }
}

/**
 * 인지 등급별 대화 적응 지시. **중증/고위험만 발동** — 정상·경증·평가전은 빈 문자열로
 * 현행 동작과 프롬프트 캐시를 보존(불필요한 토큰·동작 변경 방지).
 * 응급·안전 안내는 길이 단축에서 예외(안전 hint 충돌 방지). export: 회귀 테스트용(순수).
 */
export function buildCognitiveAdaptationHint(tier: SeverityTier): string {
  if (tier === "고위험") {
    return `\n[대화 난이도 — 인지 상태 맞춤(중요)]
어르신이 이해하기 쉽도록 **한 문장**으로, 아주 쉬운 일상 단어로만 말하세요. 한 번에 한 가지만, 가급적 예/아니오로 답할 수 있게. 천천히·필요하면 반복.
단, 응급·안전(119·복약 등) 안내는 예외로 충분히 또렷하게 설명하세요.`;
  }
  if (tier === "중증") {
    return `\n[대화 난이도 — 인지 상태 맞춤]
어르신이 따라오기 쉽게 **1~2문장**으로 짧게, 쉬운 단어로 말하세요. 한 번에 한 가지만, 복잡하거나 여러 개를 한꺼번에 묻지 마세요.
단, 응급·안전 안내는 예외로 충분히 설명하세요.`;
  }
  return "";
}
