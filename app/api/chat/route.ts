import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { authOptions } from "@/lib/auth";
import { searchMemories } from "@/lib/rag";
import type { ChatRequestBody } from "@/lib/chat/types";
import { getTimeContext, getCurrentKstDateTimeString, isDateTimeQuestion, getRelativeTimeLabel } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { saveMessages, saveGreetingMessage, saveCognitiveAssessments, markAnomaly, countRecentL1Signals } from "@/lib/chat/messages";
import { analyzeCognitive } from "@/lib/chat/cognitive-analyzer";
import { WORD_GAME_GUARDRAIL } from "@/lib/chat/constants";
import { detectInappropriate, buildModerationReply } from "@/lib/chat/moderation";
import { detectEmergency, buildEmergencyL3Reply, buildEmergencyL2Hint, shouldEscalateL1ToL2, type EmergencyResult } from "@/lib/chat/emergency";
import { prisma } from "@/lib/prisma";

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
/**
 * generateContent 결과가 비어있으면 1회 재시도. 여전히 비면 폴백 멘트 반환.
 * 빈 응답 원인: Gemini 안전 필터 차단, thinking-only output, 네트워크 순간 장애 등.
 */
function buildFallbackMessage(honorific: string, companionName: string): string {
  const variants = [
    `${honorific}, ${companionName}가 잠깐 멍해졌어요. 혹시 다시 한 번 말씀해주실래요?`,
    `어? ${companionName}가 제대로 못 들었나 봐요. 한 번만 더 얘기해주실 수 있으세요?`,
    `아이고 ${honorific}, ${companionName}가 생각이 꼬였네요. 다시 말씀해주시면 잘 들을게요!`,
    `${honorific}, 잠깐 정신이 흐릿했어요. 방금 하신 말씀 한 번 더 부탁드려도 될까요?`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

async function generateWithFallback(
  model: { generateContent: (p: any) => Promise<any> },
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

/** 잘못된 호칭 치환 — 사용자 호칭을 일관성 있게 유지. 사용자가 명시한 호칭 외 모든 친족·존칭 변형 제거.
 *
 * 중요: userHonorific의 부분 문자열인 호칭은 offenders에서 제외해야 함.
 * 예: userHonorific="할아버지"면 "아버지"를 치환하면 안 됨 (할아버지 안에 아버지 들어있음 → 할할아버지).
 * 또한 앞에 한글이 있는 경우는 더 큰 단어의 일부이므로 치환 금지.
 */
function normalizeHonorific(text: string, userHonorific: string = "할아버지"): string {
  if (!text) return text;
  // 친족 호칭 — 앞뒤 한글이 있으면 더 큰 단어(외할아버지/큰아버지)일 가능성 → 양쪽 lookahead 적용
  const KIN = ["할아버지", "할머니", "아버지", "어머니", "아빠", "엄마",
    "아저씨", "이모", "삼촌", "고모"];
  // 존칭/직함 — 뒤에 조사(과/이/에게 등)가 붙는 경우가 흔하므로 lookbehind만 적용
  const TITLE = ["회원님", "고객님", "선생님", "사장님", "어르신",
    "아버님", "어머님", "이모님", "삼촌님"];

  const filter = (arr: string[]) => arr.filter((h) => h !== userHonorific && !userHonorific.includes(h));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let out = text;
  const kinOffenders = filter(KIN).sort((a, b) => b.length - a.length);
  if (kinOffenders.length > 0) {
    const kinPat = new RegExp(`(?<![가-힣])(${kinOffenders.map(esc).join("|")})(?![가-힣])`, "g");
    out = out.replace(kinPat, userHonorific);
  }
  const titleOffenders = filter(TITLE).sort((a, b) => b.length - a.length);
  if (titleOffenders.length > 0) {
    const titlePat = new RegExp(`(?<![가-힣])(${titleOffenders.map(esc).join("|")})`, "g");
    out = out.replace(titlePat, userHonorific);
  }
  return out.replace(/(?<![가-힣])님\s*,/g, `${userHonorific},`);
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

/**
 * 단어 게임이 활성화된 맥락인지 판별 → WORD_GAME_GUARDRAIL 동적 주입.
 * 시그널: 최근 AI가 "X로 시작하는 Y" 질문을 했거나, 사용자가 게임 답변 중.
 */
function detectWordGameContext(historyText: string, userText: string): boolean {
  const combined = `${historyText}\n${userText}`;
  return /['"‘][가-힣]['"’]\s*(?:로|으로)\s*시작하는|로 시작하는 동물|로 시작하는 음식|끝말잇기|받아쓰기/.test(combined);
}

function buildWordGameHint(historyText: string, userText: string): string {
  if (!detectWordGameContext(historyText, userText)) return "";
  return `\n${WORD_GAME_GUARDRAIL}\n`;
}

/**
 * 직전 AI가 고유명사(이름/지명/사물명)를 물었고 사용자가 짧게 답한 경우,
 * 그 답을 일반 단어 의미로 해석하지 말고 "이름 그대로" 받으라는 hint 주입.
 */
function buildNameAnswerHint(historyText: string, userText: string): string {
  const userTrim = (userText || "").trim();
  if (!userTrim) return "";
  // 짧은 답 (10자 이하, 띄어쓰기 0~1회) 만 대상
  if (userTrim.length > 10 || userTrim.split(/\s+/).length > 2) return "";
  const lastAi = extractLastAiMessage(historyText);
  if (!lastAi) return "";
  const askPattern = /(이름이? (어떻게|뭐)|성함이? (어떻게|뭐)|뭐라고 부르|뭐라고 불|호칭이? (어떻게|뭐)|어디|어느 (시|도|동|동네|마을)|고향이? (어디|어느))/;
  if (!askPattern.test(lastAi)) return "";

  return `\n[직전 AI 질문 → 사용자 답변 해석 가이드]\n직전에 ${lastAi.length > 80 ? lastAi.slice(0, 80) + "…" : lastAi}\n사용자 답변 "${userTrim}"은 그 질문의 답(고유명사 — 이름/지명 등)입니다. 일반 단어 의미로 해석하지 마세요. 답변을 그대로 호명·인용하며 자연스럽게 반응하세요. 예: "아드님 성함이 '${userTrim}' 씨이군요. 친근한 이름이네요." 절대 "${userTrim}"을 형용사/감탄사로 해석하지 마세요.\n`;
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

/**
 * 끝말잇기 자동 교정 — AI가 자기 단어 X를 제시하고 사용자에게 "Y로 시작하는 단어"를 요청할 때
 * Y가 X의 마지막 글자가 아닌 경우 (예: X="가방", Y="가") 자동으로 X 마지막 글자로 교정.
 * 이는 LLM이 자주 범하는 끝말잇기 규칙 혼동을 코드 레벨에서 보정한다.
 */
const WORDCHAIN_PROPOSED = /(이번엔|이번에는|이번에)\s*'([가-힣]{1,5})'(?:이?라고)/;
const WORDCHAIN_REQUEST = /'([가-힣])'(?:로|으로)\s*시작하는\s*단어/g;

function fixWordChainStart(text: string): string {
  if (!text) return text;
  const proposed = text.match(WORDCHAIN_PROPOSED);
  if (!proposed) return text;
  const word = proposed[2];
  if (!word) return text;
  const lastChar = word[word.length - 1];
  return text.replace(WORDCHAIN_REQUEST, (full, asked: string) => {
    if (asked === lastChar) return full;
    // 잘못된 시작글자 발견 → 끝글자로 교정
    return full.replace(`'${asked}'`, `'${lastChar}'`);
  });
}

/**
 * 직전 AI 응답의 시작 문장이 새 응답에도 그대로 반복되면 첫 문장 제거.
 * 사용자가 새 주제 꺼냈는데 모델이 직전 자기 응답을 미러링하는 흔한 결함 차단.
 *
 * 판정: 새 응답의 첫 문장과 직전 AI의 첫 문장이 35자 이상 겹치거나
 *       0.7 이상 prefix 유사도면 첫 문장 삭제.
 */
function normalizeForCompare(s: string): string {
  return s.replace(/[\s.,!?~()]/g, "").toLowerCase();
}

/** historyText (buildHistoryText 결과)에서 가장 최근 AI 발화 추출. 없으면 빈 문자열. */
function extractLastAiMessage(historyText: string): string {
  if (!historyText) return "";
  const lines = historyText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // 라인 형식: "[방금] AI: ..." 또는 "AI: ..."
    const m = lines[i].match(/^(?:\[[^\]]+\]\s*)?AI:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

function removeRepeatedOpening(aiText: string, prevAiText: string): string {
  if (!aiText || !prevAiText) return aiText;
  const sentSplit = /(?<=[.!?~])\s+/;
  const newSents = aiText.split(sentSplit);
  const prevSents = prevAiText.split(sentSplit);
  if (newSents.length === 0 || prevSents.length === 0) return aiText;
  const firstNew = newSents[0].trim();
  const firstPrev = prevSents[0].trim();
  // 짧은 동조 인사("네, 알겠어요!" 등)는 그대로 둠
  if (firstNew.length < 12) return aiText;

  const a = normalizeForCompare(firstNew);
  const b = normalizeForCompare(firstPrev);
  if (!a || !b) return aiText;

  // 완전 동일 또는 한쪽이 다른 쪽으로 시작하면 무조건 제거
  if (a === b || a.startsWith(b) || b.startsWith(a)) {
    return newSents.slice(1).join(" ").trim() || aiText;
  }
  // 공통 prefix 길이로 판정
  let common = 0;
  const minLen = Math.min(a.length, b.length);
  while (common < minLen && a[common] === b[common]) common++;
  const ratio = common / Math.max(a.length, b.length);
  if (common >= 18 && ratio >= 0.7) {
    return newSents.slice(1).join(" ").trim() || aiText;
  }
  return aiText;
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
      // 내부 메타 시그니처(<!-- __mod:... -->) 제거: 모델 프롬프트에 노출 방지
      const cleaned = m.content.replace(/\s*<!--\s*__mod:[^>]*-->\s*$/g, "").trim();
      return `${timeLabel}${speaker}: ${cleaned}`;
    })
    .join("\n");
}

type GeminiTurn = { role: "user" | "model"; parts: { text: string }[] };

/**
 * 대화 이력을 Gemini multi-turn `contents` 배열로 변환.
 *
 * 텍스트로 history를 통째 stuff하는 방식 → 모델이 턴 순서/Q-A 페어를 자주 놓침.
 * Gemini가 내부적으로 사용자/모델 턴을 구분하도록 구조화된 contents로 전달한다.
 *
 * 규칙:
 * - Gemini contents는 user/model이 번갈아 와야 하므로 연속된 같은 role은 합친다
 * - 첫 turn은 반드시 user → model로 시작하면 dummy user를 앞에 추가
 * - `currentUserMessage`가 messages 끝 user 메시지와 동일하면 prior에서 제외
 * - 최종 turn은 항상 user (현재 발화) — 가이드 블록(memories/hints)을 함께 주입
 * - 직전 AI 발화가 있으면 final user 텍스트 앞에 "[직전 AI 질문에 대한 답입니다]" 마커 추가
 */
function buildChatContents(params: {
  messages: { role: string; content: string; createdAt?: string }[];
  currentUserMessage: string;
  memories: string;
  hintBlock: string;
  now?: Date;
  maxRecent?: number;
}): GeminiTurn[] {
  const { messages, currentUserMessage, memories, hintBlock, now = new Date(), maxRecent = 20 } = params;

  const recent = messages.slice(-maxRecent);
  // 마지막이 user이고 currentUserMessage와 동일하면 prior에서 제외 (텍스트 모드)
  let prior = recent;
  const lastMsg = recent[recent.length - 1];
  if (lastMsg && lastMsg.role === "user" && lastMsg.content.trim() === (currentUserMessage || "").trim()) {
    prior = recent.slice(0, -1);
  }

  const turns: GeminiTurn[] = [];
  for (const m of prior) {
    const role: "user" | "model" = m.role === "user" ? "user" : "model";
    const timeLabel = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
    const cleaned = m.content.replace(/\s*<!--\s*__mod:[^>]*-->\s*$/g, "").trim();
    if (!cleaned) continue;
    const text = `${timeLabel}${cleaned}`;
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.role === role) {
      lastTurn.parts[0].text += `\n${text}`;
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  }

  // Gemini는 첫 contents가 user여야 함 — model로 시작하면 dummy user 끼워넣기
  if (turns.length > 0 && turns[0].role === "model") {
    turns.unshift({ role: "user", parts: [{ text: "(대화 시작)" }] });
  }

  // 직전 AI 발화 확인 → 명시적 Q-A 페어링 마커
  const lastPrior = prior[prior.length - 1];
  const lastWasAi = lastPrior && lastPrior.role !== "user";
  const qaMarker = lastWasAi
    ? `[지금 사용자의 답변은 바로 위 AI의 마지막 발화에 대한 응답입니다. 새 주제가 아니라 그 흐름을 이어받으세요.]\n`
    : "";

  const cleanedHints = (hintBlock || "").trim();
  const finalText = [
    memories ? `[참고 — 과거 메모리]\n${memories}` : "",
    cleanedHints,
    `${qaMarker}[현재 사용자 발화]\n${currentUserMessage || "(빈 메시지)"}`,
  ].filter(Boolean).join("\n\n");

  // 마지막 prior turn이 user면 합치고, 아니면 새 user turn 추가
  const tail = turns[turns.length - 1];
  if (tail && tail.role === "user") {
    tail.parts[0].text += `\n\n${finalText}`;
  } else {
    turns.push({ role: "user", parts: [{ text: finalText }] });
  }
  return turns;
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
  const { text } = await generateWithFallback(
    model,
    `지금 ${userName}님이 대화를 시작합니다. ${companionRelation} '${companionName}'으로서 ${honorific}을 부르며 시간대에 맞는 인사 한 마디만 짧게 해주세요. (본인 소개 포함)`,
    `${honorific}, 안녕하세요! ${companionName}예요. 오늘 하루 어떻게 보내고 계세요?`,
  );
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 2) 재접속 인사 — AI가 먼저 인지 질문을 자연스럽게 포함 */
async function handleReturningGreeting(systemPrompt: string, userName: string, honorific: string, conversationId?: string) {
  const model = getTextModel(systemPrompt);
  const { text } = await generateWithFallback(
    model,
    `${userName}(${honorific})님이 다시 돌아왔습니다. 자기소개 반복하지 말고, "다시 오셨네요" 스타일로 따뜻하게 반겨주세요.

[중요] 인사와 함께 아래 중 하나를 자연스럽게 물어보세요:
- 시간대에 맞는 식사 질문 ("점심 맛있게 드셨어요?")
- 오늘의 기분/컨디션 ("오늘 기분이 어떠세요?")
- 인지 선별 프로토콜에서 아직 확인 안 한 영역의 질문 하나 (시험이 아닌 자연스러운 대화 형식으로)

2~3문장 이내. 절대 자기소개 반복하지 마세요.`,
    `${honorific}, 다시 오셨네요! 오늘 하루 어떻게 보내고 계세요?`,
  );
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
  messages: { role: string; content: string; createdAt?: string }[];
}) {
  const { systemPrompt, envBlock, honorific, companionName, userId, conversationId, audioData, audioMimeType, historyText, memories, messages } = params;

  // 1단계: 음성 → 텍스트 변환
  let transcription = "";
  try {
    transcription = await transcribeAudio(audioData, audioMimeType);
  } catch (e) {
    console.warn("[STT] transcription failed:", e);
  }

  // 1.4단계: 응급 발화 감지 — moderation보다 먼저
  const emergency = await evaluateEmergency({ userContent: transcription, conversationId });
  if (emergency.effectiveLevel === 3) {
    return handleEmergencyL3({
      result: emergency.result, userContent: transcription,
      conversationId, userId, honorific, companionName, transcription,
    });
  }

  // 1.5단계: 부적절 발언 감지 시 LLM 우회 + 단계적 거절
  const moderated = await handleInappropriateMessage({
    userContent: transcription,
    conversationId,
    userId,
    honorific,
    companionName,
    transcription,
  });
  if (moderated) return moderated as NextResponse;

  // 2단계: 변환된 텍스트로 대화 모델 호출 (텍스트 모델 — googleSearch 포함)
  const model = getTextModel(systemPrompt);
  const repetitionHint = buildRepetitionHint(transcription);
  const wordGameHint = buildWordGameHint(historyText, transcription);
  const nameAnswerHint = buildNameAnswerHint(historyText, transcription);
  const hintBlock = [
    repetitionHint, wordGameHint, nameAnswerHint, emergency.hint,
    "[답변 직전 점검]\n사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요. 직전 AI 발화에 사용자가 답을 했다면 그 답을 우선 인정/반영한 뒤 자연스럽게 이어가세요.",
  ].filter((s) => s && s.trim()).join("\n\n");
  const currentUserMsg = transcription || "(음성을 인식하지 못했습니다)";
  const contents = buildChatContents({ messages, currentUserMessage: currentUserMsg, memories, hintBlock });

  const fallback = buildFallbackMessage(honorific, companionName);
  const { text: rawText, fallbackUsed } = await generateWithFallback(model, { contents }, fallback);
  const ctx = `${memories || ""}\n${historyText || ""}\n${transcription || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  const answerText = fallbackUsed ? rawText : removeRepeatedOpening(fixWordChainStart(normalizeHonorific(removeUngroundedClaims(removeParrot(removeTimeLabels(trimIncomplete(rawText)), transcription, companionName), ctx), honorific)), prevAi);

  if (conversationId) {
    const { userMsgId } = await saveMessages({
      conversationId, userId,
      userContent: transcription || "(음성 메시지)",
      assistantContent: answerText,
      emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
      emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
    });
    // 인지 분석은 백그라운드 — 응답 속도에 영향 주지 않음
    runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: transcription, assistantResponse: answerText, historyText, envBlock }).catch((e) => console.error("[bg-cognitive]", e));
  }

  return NextResponse.json({
    text: answerText, transcription, role: "assistant",
    ...(emergency.effectiveLevel > 0 ? { emergency: { level: emergency.effectiveLevel, category: emergency.result.category } } : {}),
  });
}

/**
 * 응급 발화 감지 — moderation보다 먼저 분기.
 *
 * - L3: LLM 우회 즉시 응급 안내 반환 + Message에 마킹
 * - L2: hint를 호출자에게 반환(LLM 프롬프트에 주입) + Message에 마킹
 * - L1: 24h 누적 ≥3이면 L2로 승격하여 hint 반환, 아니면 마킹만
 * - 0: noop
 */
async function evaluateEmergency(params: {
  userContent: string;
  conversationId: string | undefined;
}): Promise<{ result: EmergencyResult; effectiveLevel: 0 | 1 | 2 | 3; hint: string }> {
  const { userContent, conversationId } = params;
  const result = detectEmergency(userContent);
  let effectiveLevel: 0 | 1 | 2 | 3 = result.level;

  // L1이면 누적 평가 후 L2로 승격할지 결정
  if (result.level === 1 && conversationId) {
    const recent = await countRecentL1Signals(conversationId);
    // 현재 발화 1건이 곧 저장될 예정이므로 +1로 평가
    if (shouldEscalateL1ToL2(recent + 1)) effectiveLevel = 2;
  }

  const hint = effectiveLevel === 2 ? buildEmergencyL2Hint(result.category, result.evidence) : "";
  return { result, effectiveLevel, hint };
}

async function handleEmergencyL3(params: {
  result: EmergencyResult;
  userContent: string;
  conversationId: string | undefined;
  userId: string;
  honorific: string;
  companionName: string;
  transcription?: string;
}): Promise<NextResponse> {
  const { result, userContent, conversationId, userId, honorific, companionName, transcription } = params;
  const reply = buildEmergencyL3Reply(honorific, companionName, result.category);

  if (conversationId) {
    await saveMessages({
      conversationId,
      userId,
      userContent: transcription !== undefined ? (transcription || "(음성 메시지)") : userContent,
      assistantContent: reply,
      emergencyLevel: 3,
      emergencyEvidence: `${result.category}:${result.evidence}`,
    });
  }
  const payload: Record<string, unknown> = { text: reply, role: "assistant", emergency: { level: 3, category: result.category } };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/**
 * 부적절 발언 감지 시 LLM 우회. 같은 세션 내 같은 카테고리 발생 횟수를 조회해
 * 단계적 거절 멘트를 반환하고 저장한다.
 *
 * @returns 처리된 경우 NextResponse, 정상 발화면 null
 */
async function handleInappropriateMessage(params: {
  userContent: string;
  conversationId: string | undefined;
  userId: string;
  honorific: string;
  companionName: string;
  transcription?: string;
}): Promise<Response | null> {
  const { userContent, conversationId, userId, honorific, companionName, transcription } = params;
  const moderation = detectInappropriate(userContent);
  if (moderation.category === "ok") return null;

  // 같은 세션에서 이전에 같은 카테고리 거절 멘트가 얼마나 발생했는지 카운트
  let occurrence = 1;
  if (conversationId) {
    const signature = `__mod:${moderation.category}__`;
    const prev = await prisma.message.count({
      where: { conversationId, role: "assistant", content: { contains: signature } },
    });
    occurrence = prev + 1;
  }

  const reply = buildModerationReply(moderation.category, occurrence, honorific, companionName);
  // 저장본은 표시 안 보이는 메타 시그니처를 끝에 붙여 향후 카운트에 사용
  const stored = `${reply}\n<!-- __mod:${moderation.category}__ -->`;

  if (conversationId) {
    await saveMessages({
      conversationId,
      userId,
      userContent: transcription !== undefined ? (transcription || "(음성 메시지)") : userContent,
      assistantContent: stored,
    });
  }
  const payload: Record<string, unknown> = { text: reply, role: "assistant", moderated: moderation.category };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/** 5) 텍스트 요청 (텍스트 모델 — 순수 텍스트 응답) */
async function handleTextMessage(params: {
  systemPrompt: string; envBlock: string;
  userId: string; conversationId?: string;
  userContent: string; historyText: string; memories: string;
  messages: { role: string; content: string; createdAt?: string }[];
  companionName: string; companionRelation: string; honorific: string;
}) {
  const { systemPrompt, envBlock, userId, conversationId, userContent, historyText, memories, messages, companionName, honorific } = params;

  // 응급 발화 감지 — moderation보다 먼저
  const emergency = await evaluateEmergency({ userContent, conversationId });
  if (emergency.effectiveLevel === 3) {
    return handleEmergencyL3({
      result: emergency.result, userContent,
      conversationId, userId, honorific, companionName,
    });
  }

  // 부적절 발언 감지 시 LLM 우회 + 단계적 거절
  const moderated = await handleInappropriateMessage({
    userContent,
    conversationId,
    userId,
    honorific,
    companionName,
  });
  if (moderated) return moderated as NextResponse;

  const model = getTextModel(systemPrompt);

  const repetitionHint = buildRepetitionHint(userContent);
  const wordGameHint = buildWordGameHint(historyText, userContent);
  const nameAnswerHint = buildNameAnswerHint(historyText, userContent);
  const hintBlock = [
    repetitionHint, wordGameHint, nameAnswerHint, emergency.hint,
    "[답변 직전 점검]\n사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요. 직전 AI 발화에 사용자가 답을 했다면 그 답을 우선 인정/반영한 뒤 자연스럽게 이어가세요.",
  ].filter((s) => s && s.trim()).join("\n\n");

  const contents = buildChatContents({ messages, currentUserMessage: userContent, memories, hintBlock });

  const fallback = buildFallbackMessage(honorific, companionName);
  const { text: rawText, fallbackUsed } = await generateWithFallback(model, { contents }, fallback);
  const ctx = `${memories || ""}\n${historyText || ""}\n${userContent || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  const text = fallbackUsed ? rawText : removeRepeatedOpening(fixWordChainStart(normalizeHonorific(removeUngroundedClaims(removeParrot(removeTimeLabels(trimIncomplete(rawText)), userContent, companionName), ctx), honorific)), prevAi);

  if (conversationId && userContent) {
    const { userMsgId } = await saveMessages({
      conversationId, userId, userContent, assistantContent: text,
      emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
      emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
    });
    // 인지 분석은 백그라운드 — 응답 속도에 영향 주지 않음
    runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: userContent, assistantResponse: text, historyText, envBlock }).catch((e) => console.error("[bg-cognitive]", e));
  }

  return NextResponse.json({
    text, role: "assistant",
    ...(emergency.effectiveLevel > 0 ? { emergency: { level: emergency.effectiveLevel, category: emergency.result.category } } : {}),
  });
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
        audioData: audio.data, audioMimeType: audio.mimeType, historyText, memories, messages: messages ?? [],
      });
    }

    return handleTextMessage({ systemPrompt, envBlock, userId, conversationId, userContent: lastUserMessage, historyText, memories, messages: messages ?? [], companionName, companionRelation, honorific });
  } catch (e) {
    console.error("chat api error", e);
    return NextResponse.json({ error: toSafeError(e) }, { status: 500 });
  }
}
