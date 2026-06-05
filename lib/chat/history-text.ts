/**
 * 대화 이력 텍스트 유틸 — historyText 조립 + 최근 AI 발화 추출.
 * route.ts에서 분리(2026-06-05 리팩토링). 동작 변경 없음.
 */
import { getRelativeTimeLabel } from "@/lib/chat/time";

/**
 * 대화 이력을 상대 시간 라벨과 함께 문자열로 조립.
 * 예: "[3일 전] 사용자: 부산 친구 만나기로 했어"
 * 마지막 N개만 유지 (너무 길어지면 오래된 건 RAG에서 가져오도록 분리).
 */
export function buildHistoryText(
  messages: { role: string; content: string; createdAt?: string }[],
  now: Date = new Date(),
  maxRecent: number = 20,
): string {
  const recent = messages.slice(-maxRecent);
  return recent
    .map((m) => {
      const speaker = m.role === "user" ? "사용자" : "AI";
      const timeLabel = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
      // 내부 메타 시그니처(<!-- __mod:... -->) 제거: 모델 프롬프트에 노출 방지
      const cleaned = m.content.replace(/\s*<!--\s*__mod:[^>]*-->\s*$/g, "").trim();
      return `${timeLabel}${speaker}: ${cleaned}`;
    })
    .join("\n");
}

/** historyText (buildHistoryText 결과)에서 가장 최근 AI 발화 추출. 없으면 빈 문자열. */
export function extractLastAiMessage(historyText: string): string {
  if (!historyText) return "";
  const lines = historyText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // 라인 형식: "[방금] AI: ..." 또는 "AI: ..."
    const m = lines[i].match(/^(?:\[[^\]]+\]\s*)?AI:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}
