/**
 * Gemini 모델·응답 추출 유틸 — 대화 LLM(getTextModel) + 응답 텍스트 정제(extractText/stripReasoningTrace).
 * route.ts에서 분리(2026-06-05 리팩토링).
 * 2026-06-12: deprecated @google/generative-ai → @google/genai 마이그레이션.
 *   호출부 호환을 위해 getTextModel은 구 SDK 모양({generateContent, generateContentStream→{stream,response}})의
 *   어댑터를 반환 — 스트리밍 문장 안전망(route.ts)이 무변경으로 동작.
 */
import { GoogleGenAI, HarmCategory, HarmBlockThreshold, type GenerateContentResponse } from "@google/genai";
import { nameSubj } from "@/lib/chat/korean-particle";
import { salvageJsonLeak } from "@/lib/chat/sanitize";

export function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
  return key;
}

// 신 SDK 클라이언트 싱글톤 — 모델명은 호출 시점에 전달하는 구조라 하나면 충분.
let _genAI: GoogleGenAI | null = null;
export function getGenAI(): GoogleGenAI {
  if (!_genAI) _genAI = new GoogleGenAI({ apiKey: getApiKey() });
  return _genAI;
}

/** 구 SDK 호출부 호환 — string | Content[] | {contents} 모두 신 SDK contents로 정규화 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeContents(p: any): any {
  if (typeof p === "string" || Array.isArray(p)) return p;
  return p?.contents ?? p;
}

/**
 * 안전필터 차단 해제.
 * 노인 일상 대화 도메인에선 화투·고스톱·약주·"패가 안 보인다" 같은 어르신 일상어가
 * 안전필터에 도박/유해로 오탐되어 응답을 비워버림(=빈응답 → 폴백 멘트). 어르신껜 정상 대화이므로 차단 해제.
 * 실제 유해 출력 방지는 앱 자체 모더레이션(응급·욕설 감지)과 응답 후처리(postProcessReply)가 담당.
 */
export const COMPANION_SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

/**
 * 경로별 토큰 사용량 로깅 — `DEBUG_USAGE=1`일 때만 출력. 비용 원인 추적용.
 * generateContent 결과(`{response:{usageMetadata}}`)와 stream 집계 응답(`{usageMetadata}`) 둘 다 허용.
 * 출력 예: [usage] companion model=gemini-3.5-flash input=4120 output=280 thinking=480 cached=0 total=4880
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logUsage(label: string, res: any): void {
  if (process.env.DEBUG_USAGE !== "1") return;
  try {
    const r = res?.response ?? res;
    const u = r?.usageMetadata;
    if (!u) return;
    console.log(
      `[usage] ${label} model=${r?.modelVersion ?? "?"} input=${u.promptTokenCount ?? 0} output=${u.candidatesTokenCount ?? 0} thinking=${u.thoughtsTokenCount ?? 0} cached=${u.cachedContentTokenCount ?? 0} total=${u.totalTokenCount ?? 0}`,
    );
  } catch {
    /* 로깅 실패는 무시 */
  }
}

/** 텍스트 응답용 — Gemini API + googleSearch (실시간 날짜/뉴스 필수) */
export function getTextModel(systemInstruction: string, enableSearch: boolean = true, cachedContent?: string) {
  // googleSearch는 실시간 정보(info_request: 뉴스·날씨·사실조회)에만 필요.
  // 일상 대화·공감·인지 응답엔 불필요하므로 그 턴엔 비활성해 지연·검색 비용 절감.
  const tools = enableSearch ? [{ googleSearch: {} }] : undefined;
  // gemini-3.5-flash는 thinking 모델 — 기본(무제한) thinking 예산이면 출력 전 ~10초 추론(응답 지연 주범).
  //   thinkingBudget을 낮은 양수로 제한해 추론시간 단축(첫 응답 빨라짐). 0은 빈응답 유발이라 금지(최소 64로 클램프).
  //   responseDelay 측정으로 도입(2026-06-05). COMPANION_THINKING_BUDGET env로 A/B 튜닝 가능(2026-06-11).
  const parsed = parseInt(process.env.COMPANION_THINKING_BUDGET || "512", 10);
  const THINKING_BUDGET = Number.isFinite(parsed) && parsed >= 64 ? parsed : 512;
  const ai = getGenAI();
  // 비용 최적화: 동반자(대화)는 2.5로 — 3.5는 측정상 품질 이득 없이 비용·지연만 컸음(분석기만 3.5 유지).
  const model = "gemini-2.5-flash";
  // 명시적 캐시 사용 시 systemInstruction은 캐시에 포함됨 → 호출 config엔 cachedContent만(둘 다 지정 불가).
  const config = cachedContent
    ? {
        cachedContent,
        temperature: 0.7,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: THINKING_BUDGET },
        safetySettings: COMPANION_SAFETY_SETTINGS,
        tools,
      }
    : {
        systemInstruction,
        temperature: 0.7,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: THINKING_BUDGET },
        safetySettings: COMPANION_SAFETY_SETTINGS,
        tools,
      };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContent: (p: any) => ai.models.generateContent({ model, contents: normalizeContents(p), config }),
    // 구 SDK 모양({stream, response}) 어댑터 — route.ts 스트리밍 문장 안전망이 그대로 동작.
    // chunk.text는 신 SDK에서 getter 프로퍼티 — 함수 모양으로 감싸 호출부 호환 유지.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContentStream: async (p: any) => {
      const gen = await ai.models.generateContentStream({ model, contents: normalizeContents(p), config });
      let last: GenerateContentResponse | undefined;
      const stream = (async function* () {
        for await (const chunk of gen) {
          last = chunk;
          let t = "";
          try { t = typeof chunk.text === "string" ? chunk.text : ""; } catch { t = ""; }
          yield { text: () => t };
        }
      })();
      return {
        stream,
        // 구 SDK의 집계 response 대체 — 스트림 소진 후 접근되므로 마지막 청크의 usage가 잡힘
        get response() { return { usageMetadata: last?.usageMetadata, modelVersion: last?.modelVersion }; },
      };
    },
  };
}

/**
 * generateContent 결과가 비어있으면 1회 재시도. 여전히 비면 폴백 멘트 반환.
 * 빈 응답 원인: Gemini 안전 필터 차단, thinking-only output, 네트워크 순간 장애 등.
 */
// 폴백 멘트 식별 마크 — scripts/pilot-daily-check.ts가 이 배열로 DB에서 폴백률을 집계.
//   variants가 반드시 이 마크를 포함하도록 템플릿에서 직접 참조(문구만 바꾸면 집계가 0%로 침묵하는 드리프트 방지).
export const FALLBACK_MARKS = ["잠깐 멍해졌어요", "제대로 못 들었나 봐요", "생각이 꼬였네요", "잠깐 정신이 흐릿했어요"] as const;

export function buildFallbackMessage(honorific: string, companionName: string): string {
  const variants = [
    `${honorific}, ${nameSubj(companionName)} ${FALLBACK_MARKS[0]}. 혹시 다시 한 번 말씀해주실래요?`,
    `어? ${nameSubj(companionName)} ${FALLBACK_MARKS[1]}. 한 번만 더 얘기해주실 수 있으세요?`,
    `아이고 ${honorific}, ${nameSubj(companionName)} ${FALLBACK_MARKS[2]}. 다시 말씀해주시면 잘 들을게요!`,
    `${honorific}, ${FALLBACK_MARKS[3]}. 방금 하신 말씀 한 번 더 부탁드려도 될까요?`,
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
export function extractText(res: any, opts?: { isUserSpeech?: boolean }): string {
  let raw = "";
  // gemini-3.x는 사고(thinking) part를 `thought:true`로 표시 — 그 part는 최종 응답에서 제외.
  // (text 접근자는 SDK 버전에 따라 thought part가 섞일 수 있어 part 단위로 직접 추출)
  // 신 SDK는 candidates가 응답 최상위, 구 SDK는 res.response 아래 — 둘 다 지원.
  const parts = res?.candidates?.[0]?.content?.parts ?? res?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    raw = parts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((p: any) => !p?.thought && typeof p?.text === "string")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => p.text)
      .join("");
  }
  if (!raw && typeof res?.text === "string") raw = res.text; // 신 SDK getter
  if (!raw && typeof res?.response?.text === "function") raw = res.response.text(); // 구 SDK 함수
  return stripReasoningTrace(salvageJsonLeak(raw), { isUserSpeech: opts?.isUserSpeech });
}

/**
 * Gemini thinking/reasoning 트레이스를 응답에서 제거.
 * 증상: AI 응답이 "thought The user ...", "Thought:", "**Thinking...**", 영문 reasoning 단락으로 시작.
 * 전략: 응답을 문장/줄 단위로 쪼개고 "한글 비율 40% 미만"인 선두 세그먼트는 reasoning으로 간주해 버린다.
 *       첫 한글 비율 40% 이상 세그먼트부터를 최종 응답으로 사용.
 */
export function stripReasoningTrace(text: string, opts?: { isUserSpeech?: boolean }): string {
  if (!text) return text;
  let t = text.trim();
  if (!t) return t;

  // 1) 명시적 reasoning 라벨 라인 제거 (선두)
  t = t.replace(/^\s*(?:```(?:thinking|thought)?\s*)?(?:thought|thinking|reasoning|analysis|plan|scratchpad)\s*:?\s*/i, "");
  t = t.replace(/^\s*\*{2,}\s*(?:thought|thinking|reasoning|analysis)[^*\n]*\*{2,}\s*/gi, "");
  // 1.2) 한국어 reasoning 라벨 — "(생각) …" / "생각: …" 형태. 사이클 검증에서 2.5-flash가
  //   한국어로 사고 트레이스를 누출한 케이스 발견(2026-06-10): "(생각) 할머니께서 …다고 한다."
  //   괄호로 감싸졌거나 콜론이 따라올 때만 라벨로 간주 — "생각해보니…" 같은 정상 발화는 보존.
  t = t.replace(/^\s*[([（]\s*(?:생각|사고|추론|계획|혼잣말)\s*[)\]）]\s*/, "");
  t = t.replace(/^\s*(?:생각|사고|추론|계획)\s*[:：]\s*/, "");

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
  // "~다고 한다."로 끝나는 평서 보고체 = 한국어 사고 트레이스(동반자는 해요체만 사용) — 매우 좁게 매칭해 정상 발화 보존.
  const KO_REPORTIVE_RE = /(?:다고|라고)\s*(?:한다|말한다)\s*[.!?…]*\s*$/;
  const REASONING_RE = /print\(|google_search|tool_code|tool_outputs|\bsearch\(|final polish|let'?s check|let me (check|see)|no time labels?|no hallucination|formatting\s*:|thought\s*:|thinking\s*:|the user (is|wants|said|asked|means|needs)|i should|i need to|here'?s (the|my)|draft\s*:|revision\s*:|\b(user|ai|assistant)\s*:/i;
  // KO_REPORTIVE는 동반자(AI) 출력 전용 — STT 사용자 발화에는 적용 금지:
  //   어르신 간접화법("의사가 약 바꾸라고 한다")이 정상 발화인데 삭제되면
  //   전사·DB·인지분석 입력이 조용히 훼손됨(적대적 리뷰 확인, 2026-06-11).
  const koReportiveApplies = !opts?.isUserSpeech;
  const looksLikeReasoning = (s: string) =>
    REASONING_RE.test(s) ||
    (koReportiveApplies && KO_REPORTIVE_RE.test(s)) ||
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
