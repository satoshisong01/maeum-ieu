/**
 * 인지 분석 실행 + DB 저장 — route.ts에서 추출(2026-06-12, Live 음성 경로 /api/live/turn 재사용).
 * 실패해도 대화에 영향 없음(베스트 에포트).
 */
import { analyzeCognitive } from "@/lib/chat/cognitive-analyzer";
import { saveCognitiveAssessments, markAnomaly } from "@/lib/chat/messages";
import { maybeNotifyCognitiveDecline } from "@/lib/health/cognitive-alert";

export async function runCognitiveAnalysis(params: {
  userId: string;
  conversationId: string;
  userMsgId: string;
  userMessage: string;
  assistantResponse: string;
  historyText: string;
  envBlock: string;
  honorific?: string;
}): Promise<void> {
  const { userId, conversationId, userMsgId, userMessage, assistantResponse, historyText, envBlock, honorific } = params;
  try {
    const analysis = await analyzeCognitive({ userMessage, assistantResponse, historyText, envBlock });

    // Gemini가 isAnomaly: false를 줘도, "신뢰할 만한" score >= 2 check가 있으면 강제 이상징후 판정.
    //   명시적 저신뢰(confidence < 0.6) score 2만 제외(오경보 방지). confidence는 스키마 required이며,
    //   혹시 누락되면 "미상"이지 "낮음"이 아니므로 1(신뢰)로 처리 — 0.5 디폴트는 안전망을 죽여 중증 신호를 놓쳤음(2026-06-17 fix).
    //   단 점수 자체는 cognitive_assessments에 그대로 기록되어 종단 추세엔 반영됨.
    const HIGH_SCORE_MIN_CONF = 0.6;
    const hasHighScore = analysis.cognitiveChecks.some((c) => c.score >= 2 && (c.confidence ?? 1) >= HIGH_SCORE_MIN_CONF);
    const isAnomaly = analysis.isAnomaly || hasHighScore;

    console.log("[cognitive-analysis]", JSON.stringify({
      isAnomaly, geminiSaid: analysis.isAnomaly, hasHighScore,
      checks: analysis.cognitiveChecks.length,
    }));

    // 정상(score 0) 포함 모든 체크를 저장 — 같은 영역 질문 반복 방지에 필요
    if (analysis.cognitiveChecks.length > 0) {
      await saveCognitiveAssessments(userId, userMsgId, conversationId, analysis.cognitiveChecks);
    }
    if (isAnomaly) {
      const note = analysis.analysisNote
        || analysis.cognitiveChecks.filter((c) => c.score >= 2).map((c) => `[${c.domain}] ${c.note || c.evidence}`).join("; ")
        || "인지 이상징후 감지";
      // 사용자 메시지에 이상징후 마킹 (이상 행동은 사용자 발화)
      await markAnomaly(userMsgId, note);
      // C2: 악화 추세면 보호자 알림 (C2_NOTIFY=1 게이트 + 72h 디바운스 — 이상 턴에만 평가해 집계비용 절감)
      maybeNotifyCognitiveDecline({ userId, userMsgId, userName: honorific || "사용자" })
        .then((r) => { if (r.sent) console.log("[c2-notify] sent:", r.reason); })
        .catch((e) => console.error("[c2-notify]", e));
    }
  } catch (e) {
    console.error("[cognitive-analysis] FAILED:", e);
  }
}
