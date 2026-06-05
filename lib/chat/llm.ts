/**
 * Gemini 모델·응답 추출 유틸 — 대화 LLM(getTextModel) + 응답 텍스트 정제(extractText/stripReasoningTrace).
 * route.ts에서 분리(2026-06-05 리팩토링). 동작 변경 없음.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { nameSubj } from "@/lib/chat/korean-particle";
import { salvageJsonLeak } from "@/lib/chat/sanitize";

export function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
  return key;
}

/** 텍스트 응답용 — Gemini API + googleSearch (실시간 날짜/뉴스 필수) */
export function getTextModel(systemInstruction: string, enableSearch: boolean = true) {
  // googleSearch는 실시간 정보(info_request: 뉴스·날씨·사실조회)에만 필요.
  // 일상 대화·공감·인지 응답엔 불필요하므로 그 턴엔 비활성해 지연·검색 비용 절감.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any = enableSearch ? [{ googleSearch: {} }] : undefined;
  // gemini-3.5-flash는 thinking 모델 — 기본(무제한) thinking 예산이면 출력 전 ~10초 추론(응답 지연 주범).
  //   thinkingBudget을 낮은 양수로 제한해 추론시간 단축(첫 응답 빨라짐). 0은 빈응답 유발이라 금지(THINKING_BUDGET>0).
  //   responseDelay 측정으로 도입(2026-06-05). 품질 저하 시 상향.
  const THINKING_BUDGET = 512;
  return new GoogleGenerativeAI(getApiKey()).getGenerativeModel({
    model: "gemini-3.5-flash",
    systemInstruction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: THINKING_BUDGET } } as any,
    tools,
  });
}

/**
 * generateContent 결과가 비어있으면 1회 재시도. 여전히 비면 폴백 멘트 반환.
 * 빈 응답 원인: Gemini 안전 필터 차단, thinking-only output, 네트워크 순간 장애 등.
 */
export function buildFallbackMessage(honorific: string, companionName: string): string {
  const variants = [
    `${honorific}, ${nameSubj(companionName)} 잠깐 멍해졌어요. 혹시 다시 한 번 말씀해주실래요?`,
    `어? ${nameSubj(companionName)} 제대로 못 들었나 봐요. 한 번만 더 얘기해주실 수 있으세요?`,
    `아이고 ${honorific}, ${nameSubj(companionName)} 생각이 꼬였네요. 다시 말씀해주시면 잘 들을게요!`,
    `${honorific}, 잠깐 정신이 흐릿했어요. 방금 하신 말씀 한 번 더 부탁드려도 될까요?`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

export async function generateWithFallback(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: { generateContent: (p: any) => Promise<any> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prompt: any,
  fallback: string,
): Promise<{ text: string; fallbackUsed: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await model.generateContent(prompt);
      const text = extractText(res);
      if (text && text.trim().length >= 2) return { text, fallbackUsed: false };
      console.warn(`[chat] empty response attempt ${attempt + 1}`);
    } catch (e) {
      console.warn(`[chat] generate attempt ${attempt + 1} error:`, (e as Error).message);
    }
  }
  return { text: fallback, fallbackUsed: true };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractText(res: any): string {
  let raw = "";
  // gemini-3.x는 사고(thinking) part를 `thought:true`로 표시 — 그 part는 최종 응답에서 제외.
  // (text()는 thought part까지 합쳐 추론·도구코드가 응답에 누출되므로 part 단위로 직접 추출)
  const parts = res?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    raw = parts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((p: any) => !p?.thought && typeof p?.text === "string")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => p.text)
      .join("");
  }
  if (!raw && typeof res?.response?.text === "function") raw = res.response.text();
  return stripReasoningTrace(salvageJsonLeak(raw));
}

/**
 * Gemini thinking/reasoning 트레이스를 응답에서 제거.
 * 증상: AI 응답이 "thought The user ...", "Thought:", "**Thinking...**", 영문 reasoning 단락으로 시작.
 * 전략: 응답을 문장/줄 단위로 쪼개고 "한글 비율 40% 미만"인 선두 세그먼트는 reasoning으로 간주해 버린다.
 *       첫 한글 비율 40% 이상 세그먼트부터를 최종 응답으로 사용.
 */
export function stripReasoningTrace(text: string): string {
  if (!text) return text;
  let t = text.trim();
  if (!t) return t;

  // 1) 명시적 reasoning 라벨 라인 제거 (선두)
  t = t.replace(/^\s*(?:```(?:thinking|thought)?\s*)?(?:thought|thinking|reasoning|analysis|plan|scratchpad)\s*:?\s*/i, "");
  t = t.replace(/^\s*\*{2,}\s*(?:thought|thinking|reasoning|analysis)[^*\n]*\*{2,}\s*/gi, "");

  // 1.5) 도구코드(googleSearch 등)가 포함된 코드블록은 통째로 제거
  t = t.replace(/```[\s\S]*?```/g, (block) =>
    /print\(|google_search|tool_code|tool_outputs|search\(/i.test(block) ? "" : block,
  ).trim();

  const hasHangul = (s: string) => /[가-힣]/.test(s);
  // 응답 전체가 한글이 하나도 없으면 그대로 반환 (영문 주소 등 특수 케이스)
  if (!hasHangul(t)) return t;

  const hangulRatio = (s: string) => {
    const han = (s.match(/[가-힣]/g) || []).length;
    const letters = (s.match(/[a-zA-Z가-힣]/g) || []).length;
    return letters === 0 ? 0 : han / letters;
  };

  // 추론·도구흔적으로 보이는 세그먼트 판별 (위치 무관: 뒤/중간 누출도 제거)
  const REASONING_RE = /print\(|google_search|tool_code|tool_outputs|\bsearch\(|final polish|let'?s check|let me (check|see)|no time labels?|no hallucination|formatting\s*:|thought\s*:|thinking\s*:|the user (is|wants|said|asked|means|needs)|i should|i need to|here'?s (the|my)|draft\s*:|revision\s*:|\b(user|ai|assistant)\s*:/i;
  const looksLikeReasoning = (s: string) =>
    REASONING_RE.test(s) ||
    // 한글 비율<0.3 + 영단어 4개 이상 → 영문 추론 단락으로 간주
    (hangulRatio(s) < 0.3 && (s.match(/[a-zA-Z]+/g) || []).length >= 4);

  // 2) 줄 + 문장 단위로 분리. 세그먼트 경계: 줄바꿈 또는 문장 종결(.!?) 뒤 공백.
  const segments = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
  if (segments.length === 0) return t;

  // 추론/도구 세그먼트 제거. 전부 제거되면(=오판) 원본 유지.
  const kept = segments.filter((s) => !looksLikeReasoning(s));
  if (kept.length === 0) return t;

  // 3) 남은 세그먼트 중 선두의 낮은 한글비율 잔여물 추가 스킵
  let startIdx = 0;
  for (let i = 0; i < kept.length; i++) {
    if (hangulRatio(kept[i]) >= 0.4) { startIdx = i; break; }
    if (i === kept.length - 1) startIdx = 0;
  }

  return kept.slice(startIdx).join(" ").trim();
}
