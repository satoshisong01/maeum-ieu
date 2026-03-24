/** Gemini 응답에서 JSON을 안전하게 추출 */

import type { GeminiParsedResponse } from "./types";

/** ```json ... ``` 또는 raw JSON에서 객체를 파싱 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlock ? codeBlock[1].trim() : raw.trim();
    const firstBrace = jsonStr.indexOf("{");
    if (firstBrace === -1) return null;

    const slice = jsonStr.slice(firstBrace);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === "{") depth++;
      else if (slice[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const toParse = end > 0 ? slice.slice(0, end) : slice;
    return JSON.parse(toParse) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Gemini 원시 응답을 구조화된 객체로 변환. 파싱 실패 시 원문을 text로 사용 */
export function parseGeminiResponse(raw: string): GeminiParsedResponse {
  const parsed = extractJsonObject(raw);

  const result: GeminiParsedResponse = {
    text: raw,
    isAnomaly: false,
    analysisNote: null,
  };

  if (!parsed) return result;

  if (typeof parsed.text === "string") result.text = parsed.text;
  if (typeof parsed.transcription === "string") result.transcription = parsed.transcription;
  if (parsed.isAnomaly === true && typeof parsed.analysisNote === "string") {
    result.isAnomaly = true;
    result.analysisNote = String(parsed.analysisNote).slice(0, 500);
  }

  return result;
}
