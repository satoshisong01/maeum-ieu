/**
 * 응답 본문 sanitize 유틸 — 모델 출력이 사용자에게 그대로 나가기 전 방어.
 */

const JSON_TEXT_FIELDS = ["text", "response", "reply", "message", "answer", "content", "응답", "말"];

/**
 * 모델이 본문 대신 JSON 객체를 뱉는 경우 방어 (A-3).
 * 증상(과거): `{"text":"...","isAnomaly":true,"analysisNote":...}` 가 사용자에게 그대로 노출.
 * 전략:
 *   - JSON 객체로 보이면(중괄호 시작 + "key": 시그니처) text/response/message 등 사용자용 필드만 추출.
 *   - truncated JSON이면 정규식으로 text 필드 복구.
 *   - 살릴 수 없으면 빈 문자열 반환 → 호출부(generateWithFallback)가 안전 fallback 사용.
 *   - JSON처럼 안 보이는 일반 텍스트는 그대로 통과(오작동 방지).
 */
export function salvageJsonLeak(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith("{")) return raw;
  // 진짜 JSON 객체 시그니처("key": ...)가 없으면 일반 텍스트로 간주하고 통과
  if (!/"[^"]+"\s*:/.test(s)) return raw;

  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") {
      for (const k of JSON_TEXT_FIELDS) {
        if (typeof parsed[k] === "string" && parsed[k].trim()) return parsed[k].trim();
      }
    }
  } catch {
    /* truncated/invalid — 아래 정규식 복구 시도 */
  }

  const m = s.match(/"(?:text|response|reply|message|answer|content|응답|말)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  // JSON 객체인데 텍스트 필드 복구 실패 → 원본 JSON 노출 금지, 빈 문자열로 fallback 유도
  return "";
}
