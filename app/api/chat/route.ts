import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { authOptions } from "@/lib/auth";
import { searchMemories } from "@/lib/rag";
import type { ChatRequestBody } from "@/lib/chat/types";
import { getTimeContext, getCurrentKstDateTimeString, isDateTimeQuestion, getRelativeTimeLabel } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { saveMessages, saveGreetingMessage, saveCognitiveAssessments, markAnomaly } from "@/lib/chat/messages";
import { analyzeCognitive } from "@/lib/chat/cognitive-analyzer";

// ─── Gemini 모델 ────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
  return key;
}

/** 텍스트 응답용 — Gemini API + googleSearch (실시간 날짜/뉴스 필수) */
function getTextModel(systemInstruction: string) {
  // 대화 모델은 googleSearch가 필수이므로 항상 Gemini API 사용
  // (파인튜닝 모델에는 googleSearch가 없어 실시간 정보를 가져오지 못함)
  return new GoogleGenerativeAI(getApiKey()).getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    // @ts-expect-error -- googleSearch SDK 타입 미반영
    tools: [{ googleSearch: {} }],
  });
}


// ─── 응답 텍스트 추출 (Gemini API / Vertex AI 공통) ──────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(res: any): string {
  let raw = "";
  if (typeof res?.response?.text === "function") raw = res.response.text();
  else {
    const t = res?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof t === "string") raw = t;
  }
  return stripReasoningTrace(raw);
}

/**
 * Gemini thinking/reasoning 트레이스를 응답에서 제거.
 * 증상: AI 응답이 "thought The user ...", "Thought:", "**Thinking...**", 영문 reasoning 단락으로 시작.
 * 전략: 응답을 문장/줄 단위로 쪼개고 "한글 비율 40% 미만"인 선두 세그먼트는 reasoning으로 간주해 버린다.
 *       첫 한글 비율 40% 이상 세그먼트부터를 최종 응답으로 사용.
 */
function stripReasoningTrace(text: string): string {
  if (!text) return text;
  let t = text.trim();
  if (!t) return t;

  // 1) 명시적 reasoning 라벨 라인 제거
  t = t.replace(/^\s*(?:```(?:thinking|thought)?\s*)?(?:thought|thinking|reasoning|analysis|plan|scratchpad)\s*:?\s*/i, "");
  t = t.replace(/^\s*\*{2,}\s*(?:thought|thinking|reasoning|analysis)[^*\n]*\*{2,}\s*/gi, "");

  // 2) 줄 + 문장 단위로 분리. 한글 비율이 낮은 선두 세그먼트 제거.
  //    세그먼트 경계: 줄바꿈 또는 문장 종결 (.!?) 뒤 공백.
  const segments = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
  if (segments.length === 0) return t;

  const hasHangul = (s: string) => /[가-힣]/.test(s);
  const hangulRatio = (s: string) => {
    const han = (s.match(/[가-힣]/g) || []).length;
    const letters = (s.match(/[a-zA-Z가-힣]/g) || []).length;
    return letters === 0 ? 0 : han / letters;
  };

  // 응답 전체가 한글이 하나도 없으면 그대로 반환 (영문 주소 등 특수 케이스)
  if (!hasHangul(t)) return t;

  // 선두에서 한글 비율 40% 미만인 세그먼트들을 스킵
  let startIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    if (hangulRatio(segments[i]) >= 0.4) { startIdx = i; break; }
    // 마지막 세그먼트까지 낮으면 전체 유지 (영문 응답으로 취급)
    if (i === segments.length - 1) startIdx = 0;
  }

  return segments.slice(startIdx).join(" ").trim();
}

/**
 * 앵무새 반응 제거 — AI 응답의 첫 문장이 사용자 발화 핵심 단어를 과도하게 반복하면 그 문장 삭제.
 * 예: 사용자 "된장찌개에 무랑 두부 넣어서" → AI 첫 문장 "된장찌개에 무랑 두부까지 넣어서 끓이셨다니..." → 제거
 */
function removeParrot(aiText: string, userText: string, companionName: string = "민지"): string {
  if (!aiText || !userText) return aiText;
  const stopWords = new Set(["할아버지", "할머니", "엄마", "아빠", "아버님", "어머님", "회원님", companionName, "저는", "나는", "그리고", "그래서", "정말", "오늘", "하루", "근데", "그런데", "있어", "있지", "맞아", "응"]);
  // 사용자 발화의 핵심 명사/형용사/동사 (2자 이상)
  const userTokens = userText.split(/[\s,.!?~]+/).filter((w) => w.length >= 2 && !stopWords.has(w));
  if (userTokens.length === 0) return aiText;

  const sentences = aiText.split(/(?<=[.!?~])\s+/);
  const filtered: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    // 각 문장이 사용자 발화 단어를 몇 개 포함하는지
    const hits = userTokens.filter((t) => s.includes(t)).length;
    // 사용자 단어를 3개 이상 포함 + 앵무새 정형 표현 포함 → 제거
    const isParrotPhrase = /다니\s+정말|까지\s+넣|까지\s+드|까지\s+주무|하셨다니|이라고\s+말씀|말씀해주셔서\s+고마워|셨다니/.test(s);
    if (hits >= 3 && isParrotPhrase) {
      continue; // 이 문장 제거
    }
    filtered.push(s);
  }
  const result = filtered.join(" ").trim();
  return result || aiText; // 모두 제거되면 원본 유지
}

/** 시간 라벨 누출 제거 — [방금], [3일 전], [15시간 전] 등 내부 메타데이터가 응답에 포함되면 제거 */
function removeTimeLabels(text: string): string {
  if (!text) return text;
  // [숫자+단위 전] 또는 [방금], [어제] 등 제거
  return text
    .replace(/\[\s*(방금|어제|오늘)\s*\]/g, "")
    .replace(/\[\s*\d+\s*(분|시간|일|주|주일|개월|달|년)\s*전\s*\]/g, "")
    .replace(/\[\s*오래\s*전\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 잘못된 호칭 치환 — 사용자 호칭을 일관성 있게 유지 */
function normalizeHonorific(text: string, userHonorific: string = "할아버지"): string {
  if (!text) return text;
  // "할아버지/할머니/아빠/엄마/회원님" 범주 밖의 부적절 호칭만 치환
  // 사용자 호칭이 위 5종 중 하나인 경우에만 오호칭 교체
  const STANDARD = new Set(["할아버지", "할머니", "아빠", "엄마", "회원님"]);
  if (!STANDARD.has(userHonorific)) return text; // 커스텀 호칭이면 치환 생략
  // userHonorific이 표준이면 부적절 호칭만 제거
  const offenders = ["고객님", "선생님", "사장님", "어르신"];
  // "회원님"은 40대 이하 기본이므로 60+ 노인 대상에만 교체 (할아버지/할머니인 경우)
  const replaceList = userHonorific === "할아버지" || userHonorific === "할머니"
    ? [...offenders, "회원님"]
    : offenders;
  const pattern = new RegExp(replaceList.join("|"), "g");
  return text
    .replace(pattern, userHonorific)
    .replace(/(?<![가-힣])님\s*,/g, `${userHonorific},`);
}

/**
 * 할루시네이션 가드 — AI가 사용자 발화/RAG에 없는 사실을 전제로 하는 문장 제거.
 *
 * 작동 방식:
 * 1) "~라고 하셨는데", "아까 ~ 다녀오셨다고", "~신다고 하셨" 등 **과거 전제** 표현이 포함된 문장 탐지
 * 2) 해당 문장에서 2글자 이상 한글 명사 후보 추출 (stopword 제외)
 * 3) 그 중 하나라도 context(history + rag + 현재 userContent)에 나타나지 않으면 문장 통째 제거
 */
const PREMISE_PATTERN = /[^.!?~]*?(?:라고\s*하셨|다고\s*하셨|(?:가|오)신다고\s*하셨|다녀오셨다고|드셨다고\s*하셨|주신다고\s*하셨|보셨다고\s*하셨|신다고도\s*하셨|셨다고도)[^.!?~]*[.!?~]/g;

const HALLU_STOPWORDS = new Set([
  "할아버지","할머니","민지","오늘","어제","내일","지금","아까","저번","그때","요즘","많이","정말",
  "혹시","그리고","그래서","근데","그런데","있어","있지","맞아","그때그때","말씀","생각","이야기",
  "하셨","하셨는데","하셨어요","신다고","드셨","드셨어요","가셨","오셨","보셨","했다고",
  "좀","그","이","저","것","거","수","때","안","못","때문","한번","한잔","바로","이제",
  "하루","하시","하셔","하세","이렇게","저렇게","그렇게","얼마나","어떤","누구","어디","무슨",
  "나요","예요","이에요","인가요","지요","세요","까요","네요","어요","거든","군요","잖아","그렇죠",
  "계신","계세","계시","계획","시간","준비","생활","오전","오후","새벽","사이","동안","계속","다시",
  "아니","맞다","아니라","정도","만큼","이후","이전","정말로","참","많네","많이","조금","더욱",
]);

function extractSentenceNouns(sentence: string): string[] {
  const raw = sentence.match(/[가-힣]{2,}/g) || [];
  const uniq = Array.from(new Set(raw));
  return uniq.filter((w) => !HALLU_STOPWORDS.has(w) && w.length >= 2);
}

/**
 * 직전 user 발화에서 이미 답변된 정보 카테고리 추출.
 * AI가 같은 차원을 재질문하지 못하게 system 프롬프트에 명시적으로 주입한다.
 */
function extractAnsweredSlots(userText: string): string[] {
  if (!userText) return [];
  const slots: string[] = [];
  const placeMatch = userText.match(/(복지관|노인정|병원|시장|마트|편의점|경로당|교회|공원|집|카페|식당|은행|약국|미용실|이발소|도서관|약수터)/);
  if (placeMatch) slots.push(`장소=${placeMatch[0]}`);
  const purposeMatch = userText.match(/(체조|예배|진료|장보기|산책|운동|약\s*받|이발|독서|점심|저녁|아침|모임|문병|심부름)/);
  if (purposeMatch) slots.push(`목적=${purposeMatch[0]}`);
  const timeMatch = userText.match(/(오전|오후|아침|저녁|점심|밤|새벽|지금|이따|곧|\d+시|\d+분|내일|어제|모레|주말|다음주|이번주)/);
  if (timeMatch) slots.push(`시간=${timeMatch[0]}`);
  const ageMatch = userText.match(/(\d+살|\d+세|여섯살|일곱살|여덟살|아홉살|열살|열한살|열두살)/);
  if (ageMatch) slots.push(`나이=${ageMatch[0]}`);
  const foodMatch = userText.match(/(김치|김치찌개|된장|국수|비빔밥|미역국|죽|찌개|밥|국|찜|조림|전|생선|고기|빵|죽|누룽지|두부|김밥|라면|부침개)/);
  if (foodMatch) slots.push(`음식=${foodMatch[0]}`);
  const personMatch = userText.match(/(아들|딸|며느리|사위|손자|손녀|아내|남편|친구|이웃|동창|고향친구|손주)/);
  if (personMatch) slots.push(`대상=${personMatch[0]}`);
  const moneyMatch = userText.match(/\d+원/);
  if (moneyMatch) slots.push(`금액=${moneyMatch[0]}`);
  return slots;
}

function buildRepetitionHint(userText: string): string {
  const slots = extractAnsweredSlots(userText);
  if (slots.length === 0) return "";
  return `\n[이미 답변받은 정보 — 이 차원은 절대 되묻지 마세요]\n${slots.join(" / ")}\n이 정보들은 같은 차원으로 다시 질문하면 사용자가 불쾌해합니다. 필요하면 세부/심화 질문(왜/어떻게/느낌)만 하세요.\n`;
}

function removeUngroundedClaims(aiText: string, context: string): string {
  if (!aiText) return aiText;
  const ctx = context || "";
  return aiText.replace(PREMISE_PATTERN, (sentence) => {
    const nouns = extractSentenceNouns(sentence);
    // 전제 문장 안의 명사 중 하나라도 context에 없으면 삭제
    for (const n of nouns) {
      if (!ctx.includes(n)) {
        return "";
      }
    }
    return sentence;
  }).replace(/\s{2,}/g, " ").trim();
}

/** 잘린 응답 보정 — 문장 도중에 끊긴 경우 마지막 완성 문장까지만 반환 */
function trimIncomplete(text: string): string {
  const trimmed = text.trim();
  // 마지막 문자가 문장 종결 부호면 정상
  if (/[.!?~요죠네다까세에어지만해야죠돼]$/.test(trimmed)) return trimmed;
  // 마지막 완성 문장 찾기
  const lastEnd = Math.max(
    trimmed.lastIndexOf("."),
    trimmed.lastIndexOf("!"),
    trimmed.lastIndexOf("?"),
    trimmed.lastIndexOf("~"),
    trimmed.lastIndexOf("요"),
    trimmed.lastIndexOf("죠"),
    trimmed.lastIndexOf("네요"),
  );
  if (lastEnd > trimmed.length * 0.5) return trimmed.slice(0, lastEnd + 1);
  return trimmed;
}

// ─── 공통 유틸 ──────────────────────────────────────────────────────────────

/**
 * 대화 이력을 상대 시간 라벨과 함께 문자열로 조립.
 * 예: "[3일 전] 사용자: 부산 친구 만나기로 했어"
 * 마지막 N개만 유지 (너무 길어지면 오래된 건 RAG에서 가져오도록 분리).
 */
function buildHistoryText(
  messages: { role: string; content: string; createdAt?: string }[],
  now: Date = new Date(),
  maxRecent: number = 20,
): string {
  const recent = messages.slice(-maxRecent);
  return recent
    .map((m) => {
      const speaker = m.role === "user" ? "사용자" : "AI";
      const timeLabel = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
      return `${timeLabel}${speaker}: ${m.content}`;
    })
    .join("\n");
}

async function fetchMemories(userId: string, query: string): Promise<string> {
  try { return await searchMemories(userId, query, 5); }
  catch { return ""; }
}

function toSafeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  const isQuota = /429|Too Many|quota|Quota exceeded|rate|GoogleGenerativeAI/.test(raw);
  return isQuota ? "오늘은 사용할 수 없습니다. 잠시 후 다시 시도해 주세요." : "답변 생성 중 오류가 발생했습니다.";
}

/** 인지 분석 실행 후 DB에 저장 (실패해도 대화에 영향 없음) */
async function runCognitiveAnalysis(params: {
  userId: string;
  conversationId: string;
  userMsgId: string;
  userMessage: string;
  assistantResponse: string;
  historyText: string;
  envBlock: string;
}): Promise<void> {
  const { userId, conversationId, userMsgId, userMessage, assistantResponse, historyText, envBlock } = params;
  try {
    const analysis = await analyzeCognitive({ userMessage, assistantResponse, historyText, envBlock });

    // Gemini가 isAnomaly: false를 줘도, score >= 2인 check가 있으면 강제 이상징후 판정
    const hasHighScore = analysis.cognitiveChecks.some((c) => c.score >= 2);
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
    }
  } catch (e) {
    console.error("[cognitive-analysis] FAILED:", e);
  }
}

// ─── 핸들러 ─────────────────────────────────────────────────────────────────

/** 1) 최초 인사 */
async function handleFirstGreeting(systemPrompt: string, userName: string, honorific: string, companionName: string, companionRelation: string, conversationId?: string) {
  const model = getTextModel(systemPrompt);
  const res = await model.generateContent(
    `지금 ${userName}님이 대화를 시작합니다. ${companionRelation} '${companionName}'으로서 ${honorific}을 부르며 시간대에 맞는 인사 한 마디만 짧게 해주세요. (본인 소개 포함)`,
  );
  const text = extractText(res);
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 2) 재접속 인사 — AI가 먼저 인지 질문을 자연스럽게 포함 */
async function handleReturningGreeting(systemPrompt: string, userName: string, honorific: string, conversationId?: string) {
  const model = getTextModel(systemPrompt);
  const res = await model.generateContent(
    `${userName}(${honorific})님이 다시 돌아왔습니다. 자기소개 반복하지 말고, "다시 오셨네요" 스타일로 따뜻하게 반겨주세요.

[중요] 인사와 함께 아래 중 하나를 자연스럽게 물어보세요:
- 시간대에 맞는 식사 질문 ("점심 맛있게 드셨어요?")
- 오늘의 기분/컨디션 ("오늘 기분이 어떠세요?")
- 인지 선별 프로토콜에서 아직 확인 안 한 영역의 질문 하나 (시험이 아닌 자연스러운 대화 형식으로)

2~3문장 이내. 절대 자기소개 반복하지 마세요.`,
  );
  const text = extractText(res);
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 3) 날짜/시간 질문 직접 응답 */
async function handleDateTimeQuestion(userMessage: string, honorific: string, conversationId: string | undefined, userId: string, clientTimeIso?: string) {
  const timeStr = getCurrentKstDateTimeString(clientTimeIso);
  const replyText = `${honorific}님, 지금은 한국 시각으로 ${timeStr}이에요.`;
  if (conversationId) {
    await saveMessages({ conversationId, userId, userContent: userMessage, assistantContent: replyText });
  }
  return NextResponse.json({ text: replyText, role: "assistant" });
}

/** 음성 → 텍스트 변환 (STT 전용) */
async function transcribeAudio(audioData: string, audioMimeType: string): Promise<string> {
  const sttModel = new GoogleGenerativeAI(getApiKey()).getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0, maxOutputTokens: 1024 },
  });

  const parts: Part[] = [
    { text: "이 음성을 한국어로 정확하게 받아쓰기하세요. 받아쓰기한 텍스트만 출력하세요. 다른 설명이나 주석은 절대 포함하지 마세요." },
    { inlineData: { mimeType: audioMimeType, data: audioData } },
  ];

  const res = await sttModel.generateContent({ contents: [{ role: "user", parts }] });
  return extractText(res).trim();
}

/** 4) 음성 요청 — 2단계: STT → 대화 모델 */
async function handleAudioMessage(params: {
  systemPrompt: string; envBlock: string; honorific: string; userName: string;
  companionName: string; companionRelation: string;
  userId: string; conversationId?: string;
  audioData: string; audioMimeType: string; historyText: string; memories: string;
}) {
  const { systemPrompt, envBlock, honorific, companionName, userId, conversationId, audioData, audioMimeType, historyText, memories } = params;

  // 1단계: 음성 → 텍스트 변환
  let transcription = "";
  try {
    transcription = await transcribeAudio(audioData, audioMimeType);
  } catch (e) {
    console.warn("[STT] transcription failed:", e);
  }

  // 2단계: 변환된 텍스트로 대화 모델 호출 (텍스트 모델 — googleSearch 포함)
  const model = getTextModel(systemPrompt);
  const repetitionHint = buildRepetitionHint(transcription);
  const prompt = `${memories ? `과거 맥락:\n${memories}\n` : ""}
대화 내역:
${historyText}
${repetitionHint}
사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요.

[이번 턴]
사용자: ${transcription || "(음성을 인식하지 못했습니다)"}`;

  const res = await model.generateContent(prompt);
  const ctx = `${memories || ""}\n${historyText || ""}\n${transcription || ""}`;
  const answerText = normalizeHonorific(removeUngroundedClaims(removeParrot(removeTimeLabels(trimIncomplete(extractText(res))), transcription, companionName), ctx), honorific);

  if (conversationId) {
    const { userMsgId } = await saveMessages({
      conversationId, userId,
      userContent: transcription || "(음성 메시지)",
      assistantContent: answerText,
    });
    // 인지 분석은 백그라운드 — 응답 속도에 영향 주지 않음
    runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: transcription, assistantResponse: answerText, historyText, envBlock }).catch((e) => console.error("[bg-cognitive]", e));
  }

  return NextResponse.json({ text: answerText, transcription, role: "assistant" });
}

/** 5) 텍스트 요청 (텍스트 모델 — 순수 텍스트 응답) */
async function handleTextMessage(params: {
  systemPrompt: string; envBlock: string;
  userId: string; conversationId?: string;
  userContent: string; historyText: string; memories: string;
  companionName: string; companionRelation: string; honorific: string;
}) {
  const { systemPrompt, envBlock, userId, conversationId, userContent, historyText, memories, companionName, honorific } = params;
  const model = getTextModel(systemPrompt);

  const repetitionHint = buildRepetitionHint(userContent);
  const prompt = `${memories ? `과거 맥락:\n${memories}\n` : ""}
대화 내역:
${historyText}
${repetitionHint}
사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요.`;

  const res = await model.generateContent(prompt);
  const ctx = `${memories || ""}\n${historyText || ""}\n${userContent || ""}`;
  const text = normalizeHonorific(removeUngroundedClaims(removeParrot(removeTimeLabels(trimIncomplete(extractText(res))), userContent, companionName), ctx), honorific);

  if (conversationId && userContent) {
    const { userMsgId } = await saveMessages({ conversationId, userId, userContent, assistantContent: text });
    // 인지 분석은 백그라운드 — 응답 속도에 영향 주지 않음
    runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: userContent, assistantResponse: text, historyText, envBlock }).catch((e) => console.error("[bg-cognitive]", e));
  }

  return NextResponse.json({ text, role: "assistant" });
}

// ─── POST ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const body = (await req.json()) as ChatRequestBody;
    const { messages, conversationId, isInitialGreeting, isReturningGreeting, audio, context: ctx } = body;
    const userId = session.user.id;

    const timeCtx = getTimeContext(ctx?.currentTime);
    const weatherCtx = await getWeatherContext(ctx?.latitude, ctx?.longitude);
    const { systemPrompt, envBlock, userName, honorific, companionName, companionRelation } = await buildSystemPrompt({
      userId, conversationId, timeCtx, weather: weatherCtx,
    });

    if (isInitialGreeting) return handleFirstGreeting(systemPrompt, userName, honorific, companionName, companionRelation, conversationId);
    if (isReturningGreeting) return handleReturningGreeting(systemPrompt, userName, honorific, conversationId);

    const lastUserMessage = messages?.filter((m) => m.role === "user").pop()?.content ?? "";
    const [memories, historyText] = await Promise.all([
      fetchMemories(userId, lastUserMessage),
      Promise.resolve(buildHistoryText(messages ?? [])),
    ]);

    if (!audio?.data && lastUserMessage && isDateTimeQuestion(lastUserMessage)) {
      return handleDateTimeQuestion(lastUserMessage, honorific, conversationId, userId, ctx?.currentTime);
    }

    if (audio?.data && audio?.mimeType) {
      return handleAudioMessage({
        systemPrompt, envBlock, honorific, userName, companionName, companionRelation, userId, conversationId,
        audioData: audio.data, audioMimeType: audio.mimeType, historyText, memories,
      });
    }

    return handleTextMessage({ systemPrompt, envBlock, userId, conversationId, userContent: lastUserMessage, historyText, memories, companionName, companionRelation, honorific });
  } catch (e) {
    console.error("chat api error", e);
    return NextResponse.json({ error: toSafeError(e) }, { status: 500 });
  }
}
