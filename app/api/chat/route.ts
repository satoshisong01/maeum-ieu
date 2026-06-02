import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { authOptions } from "@/lib/auth";
import { searchMemories } from "@/lib/rag";
import { extractAndSaveProfile } from "@/lib/chat/profile-extractor";
import { factCheckResponse } from "@/lib/chat/fact-checker";
import type { FullProfile } from "@/lib/chat/profile";
import { maybeTriggerSummaryRollup } from "@/lib/chat/summary-trigger";
import { nameSubj, normalizeImnida, stripRecallAnswerLeak } from "@/lib/chat/korean-particle";
import { salvageJsonLeak } from "@/lib/chat/sanitize";
import { classifyIntent, buildIntentHint } from "@/lib/chat/intent-classifier";
import type { ChatRequestBody } from "@/lib/chat/types";
import { getTimeContext, getCurrentKstDateTimeString, isDateTimeQuestion, getRelativeTimeLabel } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { saveMessages, saveGreetingMessage, saveCognitiveAssessments, markAnomaly, countRecentL1Signals } from "@/lib/chat/messages";
import { analyzeCognitive } from "@/lib/chat/cognitive-analyzer";
import { WORD_GAME_GUARDRAIL } from "@/lib/chat/constants";
import { detectInappropriate, buildModerationReply } from "@/lib/chat/moderation";
import { detectEmergency, buildEmergencyL3Reply, buildEmergencyL2Hint, shouldEscalateL1ToL2, type EmergencyResult } from "@/lib/chat/emergency";
import { evaluateSttConfidence, buildClarificationReply } from "@/lib/chat/stt-confidence";
import { correctTranscriptionByContext } from "@/lib/chat/stt-context-correction";
import { notifyGuardian } from "@/lib/chat/emergency-notify";
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
    `${honorific}, ${nameSubj(companionName)} 잠깐 멍해졌어요. 혹시 다시 한 번 말씀해주실래요?`,
    `어? ${nameSubj(companionName)} 제대로 못 들었나 봐요. 한 번만 더 얘기해주실 수 있으세요?`,
    `아이고 ${honorific}, ${nameSubj(companionName)} 생각이 꼬였네요. 다시 말씀해주시면 잘 들을게요!`,
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
  return stripReasoningTrace(salvageJsonLeak(raw));
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
    // lookbehind: 앞에 한글이 오면 더 큰 단어(외할아버지/큰아버지)일 가능성 — 매칭 X
    // lookahead: 뒤에 일반 한글 조사(의/은/는/이/가/께/께서/와/과/한테/에게/도/만)는 허용,
    //           나머지 한글이 붙으면 다른 명사일 가능성 → 매칭 X
    const kinPat = new RegExp(
      `(?<![가-힣])(${kinOffenders.map(esc).join("|")})(?=$|[^가-힣]|의|은|는|이|가|을|를|와|과|랑|이랑|도|만|께|께서|한테|에게|에서|로|으로)`,
      "g"
    );
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
 * 자녀·손주 호칭 정규화 — AI가 "영민 씨/재미 씨" 같이 자녀에게 사회적 존칭 "씨"를 붙이는 패턴 제거.
 *
 * 동작 방식:
 * 1) context(사용자 발화 + 이력)에서 친근 종조사("이가/이는/이도/이야/야")로 호명된 이름 추출 → familiar set
 *    예: "영민이가 와서", "재미는 일이 바빠" → {영민, 재미}
 * 2) AI 응답에서 (familiar 이름) + 공백 + "씨" 패턴 → "씨" 제거
 *    예: "영민 씨가" → "영민이가", "재미 씨는" → "재미는"
 *
 * 부모가 자식·손주에게 "씨" 붙이는 건 한국어로 매우 부자연스러움. prompt만으로 LLM이 따르지 않아 후처리 추가.
 */
/**
 * 자녀 성별 호칭 자동 정정 — DB family relation을 ground truth로 사용.
 *
 * 예: family에 "수진(daughter)" 저장돼 있는데 AI가 "수진 아드님"이라 답하면 → "수진 따님"으로 swap.
 *     family에 "민호(son)" 저장돼 있는데 AI가 "민호 따님"이라 답하면 → "민호 아드님"으로 swap.
 *
 * Why: prompt block에 family 정보가 있어도 LLM이 가끔 성별을 헷갈림.
 *      DB 신뢰 우선 — 2026-05-26 rudtjrch cycle에서 "큰딸 수진이" → "수진 아드님" 회귀 발견.
 */
function fixChildGenderHonorific(text: string, family: Array<{ name: string; relation: string }>): string {
  if (!text || !family || family.length === 0) return text;
  let out = text;
  for (const f of family) {
    const name = f.name;
    if (!name || name.length < 2) continue;
    if (f.relation === "daughter") {
      // 딸인데 "아드님"으로 호칭한 경우 → "따님"으로
      out = out.replace(new RegExp(`${name}\\s*아드님`, "g"), `${name} 따님`);
      out = out.replace(new RegExp(`${name}\\s*아들`, "g"), `${name} 딸`);
    } else if (f.relation === "son") {
      // 아들인데 "따님"으로 호칭한 경우 → "아드님"으로
      out = out.replace(new RegExp(`${name}\\s*따님`, "g"), `${name} 아드님`);
      out = out.replace(new RegExp(`${name}\\s*딸(?!기|기는|기와|기랑)`, "g"), `${name} 아들`);
    }
  }
  return out;
}

function normalizeFamilyChildHonorific(text: string, ctx: string): string {
  if (!text || !ctx) return text;
  const familiar = new Set<string>();
  // 1) 친근 종조사로 호명된 이름 (받침 있는 이름: "영민이가/영민이는")
  const familiarPattern = /([가-힣]{2,3})(?:이가|이는|이도|이야|이를|이랑|이한테|이에게|야\s)/g;
  let m: RegExpExecArray | null;
  while ((m = familiarPattern.exec(ctx)) !== null) {
    familiar.add(m[1]);
  }
  // 2) 가족 관계 + 이름 패턴 (받침 없는 이름까지 포함: "큰아들이 재미", "둘째가 영민")
  const familyRelationPattern = /(?:큰?아들|장남|차남|막내아들|딸|장녀|차녀|막내딸|첫째|둘째|셋째|넷째|막내|손자|손녀|아내|남편)(?:이?|가|는|이름은?|은|이름이)\s*([가-힣]{2,3})(?:이고|이며|이지|이야|고|이에요|예요|이|$|\s)/g;
  while ((m = familyRelationPattern.exec(ctx)) !== null) {
    familiar.add(m[1]);
  }
  if (familiar.size === 0) return text;

  let out = text;
  for (const name of familiar) {
    // "이름 씨" + 조사(가/는/이/도/를/랑/한테/에게)
    const pattern = new RegExp(`${name}\\s*씨(?=\\s*(?:가|는|이|도|를|랑|한테|에게|의|와|과)?)`, "g");
    // 사용자가 부르는 형태 그대로 (이가/이는/이도 → 이) 또는 이름만
    out = out.replace(pattern, (match) => {
      // 뒤에 조사가 있으면 친근 형태로 변환, 없으면 이름만
      const rest = out.slice(out.indexOf(match) + match.length);
      // 단순 치환: "씨" 제거하고 친근 종조사 "이" 추가가 가능한 경우
      // 안전한 기본: "OO 씨" → "OO" (조사는 그대로)
      return name;
    });
  }
  return out;
}

/**
 * 할루시네이션 가드 — AI가 사용자 발화/RAG에 없는 사실을 전제로 하는 문장 제거.
 *
 * 작동 방식:
 * 1) "~라고 하셨는데", "아까 ~ 다녀오셨다고", "~신다고 하셨" 등 **과거 전제** 표현이 포함된 문장 탐지
 * 2) 해당 문장에서 2글자 이상 한글 명사 후보 추출 (stopword 제외)
 * 3) 그 중 하나라도 context(history + rag + 현재 userContent)에 나타나지 않으면 문장 통째 제거
 */
// 과거 전제 표현 — AI가 사용자 발화/메모리에 없는 사실을 전제로 하는 문장 매칭.
// 어르신 안정성 핵심: 추측 사실을 "~라고 하셨" 식으로 가정하면 신뢰 무너짐.
// narrow: "전제 표현 + 종결동사" 페어만 매칭 (단순 "아까 말씀" 같은 일반 표현 제외)
const PREMISE_PATTERN = /[^.!?~]*?(?:라고\s*하셨|다고\s*하셨|(?:가|오)신다고\s*하셨|다녀오셨다고|드셨다고\s*하셨|주신다고\s*하셨|보셨다고\s*하셨|신다고도\s*하셨|셨다고도|말씀하셨던|들으셨던\s*[가-힣]+|하셨던\s*[가-힣]+|드셨던\s*[가-힣]+|보셨던\s*[가-힣]+|가셨던\s*[가-힣]+|아까\s*말씀하셨|아까\s*드셨다고|지난번에\s*말씀하셨|예전에\s*말씀하셨|전에\s*하셨다고|어제\s*말씀하셨)[^.!?~]*[.!?~]/g;

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

/**
 * 사망인물·비현실 대상 + 최근 시제 동반 발화 → AI가 부드럽게 정정하도록 prompt-time hint.
 *
 * Why: cognitive-analyzer의 injectJudgmentSafetyNet은 post-response DB marking 용도.
 *      AI 실제 응답에 영향을 주려면 prompt 시점 hint가 필요. 2026-05-26 rudtjrch
 *      cycle에서 "이순신 장군이 어제 동네 왔다 가셨어"에 AI가 회피 답변하던 회귀 발견.
 */
const DECEASED_FIGURES_HINT = /(박정희|이승만|전두환|김구|김대중|노무현|이순신|세종대왕|광개토|영조|정조|숙종|태조|마더\s*테레사|히틀러|마오쩌둥|레닌|스탈린)/;
const SURREAL_BEINGS_HINT = /(외계인|공룡|UFO|도깨비|유령|호랑이|사자|코끼리|기린)/;
const RECENT_TIME_CONTACT_HINT = /(어제|오늘|방금|아까|지금|이번\s*주|지난\s*주|아침|저녁|점심|새벽|밤에).*(만났|만나|왔|와서|봤|보았|먹었|마셨|했|같이|차\s*한잔|대화|이야기|놀러|들렀|다녀|머물|머무|점심|저녁\s*먹)|(만났|왔|봤|먹었|같이|놀러|들렀|다녀).*(어제|오늘|방금|아까|지금|이번\s*주|지난\s*주)/;
function buildAnomalyCorrectionHint(userText: string): string {
  if (!userText) return "";
  const deceased = DECEASED_FIGURES_HINT.test(userText) ? userText.match(DECEASED_FIGURES_HINT)![0] : null;
  const surreal = SURREAL_BEINGS_HINT.test(userText) ? userText.match(SURREAL_BEINGS_HINT)![0] : null;
  const recentTime = RECENT_TIME_CONTACT_HINT.test(userText);
  if (!deceased && !surreal) return "";
  if (!recentTime) return "";
  const subject = deceased || surreal!;
  const reason = deceased
    ? `${deceased}는(은) 역사 속 인물 또는 이미 돌아가신 분`
    : `${surreal}는(은) 일상에서 마주칠 수 없는 비현실 대상`;
  return `\n[🚫 인지 안전망 — 사실 확인 필수]\n사용자가 "${subject}" 와(과) 최근 시제(어제/오늘/방금 등)를 함께 언급했습니다. ${reason}이에요.\n절대 사용자 발화를 그대로 받아들여 "그러셨군요" 하지 마세요. 부드럽게 사실을 확인해주세요.\n예시: "할아버지/할머니, ${subject}은(는) 아주 오래전 분이시잖아요. 혹시 TV 사극이나 꿈에서 보신 건 아닐까요?" 또는 "비슷한 이름의 다른 분이 다녀가신 거 아닐까요?"\n절대 "정확히 기억이 안 나서" 같은 회피 답변 금지. 사용자가 헷갈리는 부분을 친절히 짚어드리는 게 어르신 안전·신뢰의 핵심입니다.\n`;
}

/**
 * 가족 정보 조회 요청에 대한 환각 차단 hint.
 *
 * 사용자가 "큰아들이 누구야/큰딸 이름이 뭐였지" 식으로 가족 정보를 직접 물었는데,
 * profile.family에 해당 관계+순서의 ground-truth가 없으면 LLM이 다른 가족 이름을
 * 잘못 답하거나 동문서답함 → 솔직히 "아직 안 들었어요"라고 답하도록 강제.
 *
 * Why: 2026-05-26 rudtjrch cycle에서 "큰아들이 누구라고 했지?" → AI가 동문서답.
 */
const FAMILY_QUERY_PATTERN = /(?:큰\s*아들|장남|첫째\s*아들|둘째\s*아들|차남|막내\s*아들|큰\s*딸|장녀|첫째\s*딸|둘째\s*딸|차녀|막내\s*딸|손주|손자|손녀|아내|남편|영감|안사람)(?:이|가|은|는|의)?\s*(?:이름|성함|누구|뭐|뭐였|뭐죠|뭐예요|어떻게|어디|어떤)/;
function buildFamilyQueryGuard(userText: string, family: Array<{ name: string; relation: string; orderIdx?: number | null }>): string {
  if (!userText) return "";
  if (!FAMILY_QUERY_PATTERN.test(userText)) return "";
  // 가족 관계+순서별 ground truth 존재 여부 확인
  const has = {
    bigSon: family.some((f) => f.relation === "son" && (f.orderIdx === 1 || f.orderIdx === null)),
    secondSon: family.some((f) => f.relation === "son" && f.orderIdx === 2),
    bigDaughter: family.some((f) => f.relation === "daughter" && (f.orderIdx === 1 || f.orderIdx === null)),
    secondDaughter: family.some((f) => f.relation === "daughter" && f.orderIdx === 2),
    grandchild: family.some((f) => f.relation === "grandchild"),
    spouse: family.some((f) => f.relation === "spouse"),
  };
  // 질문에 해당하는 정보가 DB에 있는지 매칭
  const askBigSon = /큰\s*아들|장남|첫째\s*아들/.test(userText);
  const askSecondSon = /둘째\s*아들|차남/.test(userText);
  const askBigDaughter = /큰\s*딸|장녀|첫째\s*딸/.test(userText);
  const askSecondDaughter = /둘째\s*딸|차녀/.test(userText);
  const askGrandchild = /손주|손자|손녀/.test(userText);

  const missing: string[] = [];
  if (askBigSon && !has.bigSon) missing.push("큰아들");
  if (askSecondSon && !has.secondSon) missing.push("둘째아들");
  if (askBigDaughter && !has.bigDaughter) missing.push("큰딸");
  if (askSecondDaughter && !has.secondDaughter) missing.push("둘째딸");
  if (askGrandchild && !has.grandchild) missing.push("손주");

  if (missing.length === 0) return "";
  return `\n[🚫 가족 정보 환각 차단 — 매우 중요]\n사용자가 "${missing.join("/")}" 정보를 직접 물어보셨는데, 우리 DB에는 아직 이 관계의 가족 정보가 저장돼 있지 않아요. (즉 사용자가 이전에 말씀해주신 적 없음)\n절대 다른 가족 이름을 끌어와 답하지 마세요. 절대 화제 전환하지 마세요. 솔직하게 "어, 죄송해요. ${missing[0]} 성함은 아직 안 알려주신 것 같아요. 혹시 ${missing[0]} 성함이 어떻게 되세요?" 라고 답하세요.\n사용자가 "기억하지?"라고 물어도 모르는 건 솔직히 모른다고 인정 — 어르신 신뢰의 핵심.\n`;
}

/**
 * 회상 검증 hint — 사용자가 "방금 외운 단어/세 단어 다시" 요청했는데
 * conversation history에 AI가 단어를 외워준 흔적이 없으면 환각 차단.
 *
 * Why: 새 conversation 직후 회상 요청 시 AI가 "나무/자동차/모자" 같은 단어를
 *      만들어내는 거짓 메모리 발생. 노인 사용자 신뢰 붕괴 위험.
 */
function buildRecallVerificationHint(historyText: string, userText: string): string {
  if (!userText) return "";
  const recallAsk = /(방금|아까|좀\s*전|먼저)?\s*(외운|외워준|외워주신|들려준|말해준|알려준)\s*(단어|세\s*단어|세\s*가지|단어\s*세|단어들)|단어\s*다시|단어\s*뭐였|단어\s*뭐죠|단어\s*기억\s*나|세\s*단어\s*기억|세\s*가지\s*기억/;
  if (!recallAsk.test(userText)) return "";
  const aiPresented = /외워\s*(드릴게요|드릴게|드리겠어요|두세요|두시면|두시고|볼까요|봐주세요)|단어\s*세\s*(가지|개)\s*(을|를|만)?\s*(말씀|드리|말해|읽어)|단어\s*세\s*(가지|개)\s*(외워|기억)/.test(historyText);
  if (aiPresented) return "";
  return `\n[🚫 회상 검증 — 매우 중요, 환각 절대 금지]\n이번 대화에서 민지가 단어를 외워드린 적이 한 번도 없습니다. 그런데 사용자가 "방금 외운 단어"를 물으셨어요.\n절대 임의로 "나무, 자동차, 모자" 같은 단어를 만들어 답하지 마세요 (없는 기억 만들기 = 환각, 신뢰 붕괴).\n대신 이렇게 답하세요: "어, 민지가 아직 단어를 외워드린 적이 없는 것 같아요. 지금 새로 외워드릴까요? 그럼 [실제 새 단어 3개] — 이렇게 세 개 외워주세요." 또는 "혹시 어디서 들으신 거 같으세요? 지금부터 함께 단어 외우기 해볼까요?"\n`;
}

/**
 * 사용자가 자기 정보를 헷갈려하거나 직접 정보를 요청하는 패턴 감지 → 평가 모드 강제 해제.
 *
 * 트리거 표현: "기억하지?", "알려줘", "뭐였더라", "헷갈리네", "까먹었어", "모르겠어", "누가"
 * → AI가 "민지가 깜빡했어요/헷갈려서" 같은 평가 모드 핑계 대지 말고
 *   RAG/대화 이력에서 정보 찾아서 부드럽게 알려주도록 강제.
 *
 * 안전성 우선 — 어르신이 헷갈릴 때 시스템이 같이 흔들리면 신뢰 무너짐.
 */
function buildInfoRequestHint(userText: string): string {
  if (!userText) return "";
  const directAsk = /기억하지|기억해\??|기억나|알려\s*줘|알려\s*주|뭐였더라|뭐였지|뭐였어|누구였|누가|어디였|언제였|헷갈리네|헷갈려|까먹었|까먹어|모르겠어|모르겠다|잊어버렸|생각 안 나|생각이 안/.test(userText);
  if (!directAsk) return "";
  return `\n[🛡️ 사용자가 직접 정보를 요청하거나 헷갈려함 — 평가 모드 절대 금지]
- 사용자가 자기 정보를 헷갈려하거나 AI에게 직접 알려달라고 했습니다.
- 이 순간 "민지가 헷갈려서/깜빡해서/기억이 안 나서" 같은 평가용 핑계 절대 금지.
- [참고 — 과거 메모리]나 직전 대화 이력에서 답이 명확하면 **솔직하게 알려주세요**. "할아버지가 ~라고 말씀해주셨어요" 형식.
- 만약 메모리/이력에 답이 명확히 없으면 "민지가 정확히 기억이 안 나네요. 다시 알려주시겠어요?" 라고 솔직히 인정.
- 절대 추측하지 마세요. 메모리에 없는 정보를 지어내면 어르신 신뢰가 무너집니다.\n`;
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

/**
 * RAG 메모리 조회 — searchMemories에 DISTINCT ON dedup + limit 15.
 *
 * 진단 결과(2026-05-26): "마당 청소 좀 했어" 같은 발화가 4번 중복 임베딩되어 top 차지,
 *   다양성 있는 다른 메시지(제라늄/백일홍)가 밀려남. dedup으로 해결.
 * enriched query(recent 3 join)는 가족/명절 토픽이 너무 강해져 마당/화분이 희석되는 부작용 있어 미사용.
 */
async function fetchMemories(userId: string, query: string): Promise<string> {
  try { return await searchMemories(userId, query, 15); }
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
  const { text: raw } = await generateWithFallback(
    model,
    `지금 ${userName}님이 대화를 시작합니다. ${companionRelation} '${companionName}'으로서 ${honorific}을 부르며 시간대에 맞는 인사 한 마디만 짧게 해주세요. (본인 소개 포함)`,
    `${honorific}, 안녕하세요! ${companionName}예요. 오늘 하루 어떻게 보내고 계세요?`,
  );
  const text = normalizeImnida(raw);  // "수지이에요" → "수지예요"
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 2) 재접속 인사 — AI가 먼저 인지 질문을 자연스럽게 포함 */
async function handleReturningGreeting(systemPrompt: string, userName: string, honorific: string, conversationId?: string) {
  const model = getTextModel(systemPrompt);
  const { text } = await generateWithFallback(
    model,
    `${userName}(${honorific})님이 다시 돌아왔습니다. 자기소개 반복하지 말고, "다시 오셨네요" 스타일로 따뜻하게 반겨주세요.

[중요 — 시간대에 맞는 인사·식사 질문]
위 [현재 환경 정보]의 "시간대" 라벨(새벽/아침/오전/점심/오후/저녁/밤)을 **반드시 확인**해서 시간대에 맞는 식사 질문을 하세요:
- 새벽/아침 (~10시): "아침은 드셨어요?" / "잘 주무셨어요?"
- 오전 (10~11시): "오전은 어떻게 보내고 계세요?"
- 점심 (11~14시): "점심 맛있게 드셨어요?"
- 오후 (14~17시): "점심 뭐 드셨어요?" 또는 "오후엔 뭐 하고 계세요?"
- 저녁 (17~20시): "저녁 준비하셨어요?" 또는 "오늘 하루 어떠셨어요?"
- 밤 (20시 이후): "오늘 하루 잘 보내셨어요?"
**시간대와 다른 식사 질문(아침인데 "점심 드셨어요?")은 절대 금지**.

또는 아래 중 하나로 대체 가능:
- 오늘의 기분/컨디션 질문
- 인지 선별 프로토콜에서 아직 확인 안 한 영역의 질문 하나 (시험이 아닌 자연스러운 대화 형식으로)

2~3문장 이내. 절대 자기소개 반복하지 마세요.`,
    `${honorific}, 다시 오셨네요! 오늘 하루 어떻게 보내고 계세요?`,
  );
  const cleaned = normalizeImnida(text);
  if (conversationId) await saveGreetingMessage(conversationId, cleaned);
  return NextResponse.json({ text: cleaned, role: "assistant" });
}

/** 3) 날짜/시간 질문 직접 응답 */
async function handleDateTimeQuestion(userMessage: string, honorific: string, conversationId: string | undefined, userId: string, clientTimeIso?: string) {
  const timeStr = getCurrentKstDateTimeString(clientTimeIso);
  // honorific 자체가 "할아버지"/"할머니"/"어머니"처럼 이미 친족 호칭이므로
  // "님" 접미 없이 그대로 사용. ("할아버지님" 같은 어색한 호명 방지)
  const replyText = `${honorific}, 지금은 한국 시각으로 ${timeStr}이에요.`;
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
  profile: FullProfile;
}) {
  const { systemPrompt, envBlock, honorific, companionName, userId, conversationId, audioData, audioMimeType, historyText, memories, messages, profile } = params;

  // 1단계: 음성 → 텍스트 변환
  let transcription = "";
  try {
    transcription = await transcribeAudio(audioData, audioMimeType);
  } catch (e) {
    console.warn("[STT] transcription failed:", e);
  }

  // 1.4단계: 응급 발화 감지 — moderation·STT 게이트보다 먼저 (안전 우선)
  const emergency = await evaluateEmergency({ userContent: transcription, conversationId });
  if (emergency.effectiveLevel === 3) {
    return handleEmergencyL3({
      result: emergency.result, userContent: transcription,
      conversationId, userId, honorific, companionName, transcription,
    });
  }

  // 1.45단계: STT 신뢰도 게이트 — 인식 결과가 잡음/짧음/오인식이면 LLM 우회하고 재질문
  //   응급/모더레이션 매칭이 없는 경우에만 실행. 신뢰도 통과한 발화만 인지 분석에 들어가도록.
  const sttConf = evaluateSttConfidence(transcription);
  if (!sttConf.pass) {
    console.log("[stt-confidence] failed:", sttConf.reason, "tx:", JSON.stringify(transcription).slice(0, 80));
    const clarification = buildClarificationReply(honorific, companionName);
    if (conversationId) {
      // 사용자 발화는 잡음/오인식이므로 따로 마커를 붙여 저장 (디버깅용)
      const userTag = transcription && transcription.trim().length > 0
        ? `(STT 저신뢰: ${transcription.trim().slice(0, 60)})`
        : "(음성 메시지 — 인식 실패)";
      await saveMessages({
        conversationId, userId,
        userContent: userTag,
        assistantContent: clarification,
      });
    }
    return NextResponse.json({
      text: clarification, transcription, role: "assistant",
      sttFailed: true, sttReason: sttConf.reason,
    });
  }

  // 1.48단계: 맥락 기반 STT 보정 — 직전 AI 발화 도메인에 맞춰 어휘 교정
  //   "미빈밥" → "비빔밥", "혈양약" → "혈압약" 같은 오인식을 인지 분석기 도달 전에 차단.
  const lastAi = extractLastAiMessage(historyText);
  const correction = correctTranscriptionByContext(transcription, lastAi);
  if (correction.changes.length > 0) {
    console.log("[stt-context-correction]", JSON.stringify({
      original: transcription,
      corrected: correction.corrected,
      changes: correction.changes,
    }));
    transcription = correction.corrected;
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
  const recallVerifyHint = buildRecallVerificationHint(historyText, transcription);
  const anomalyHint = buildAnomalyCorrectionHint(transcription);
  const familyQueryGuard = buildFamilyQueryGuard(transcription, profile.family);
  const infoRequestHint = buildInfoRequestHint(transcription);
  const intent = classifyIntent(transcription);
  const intentHint = buildIntentHint(intent, honorific);
  if (intent.primary !== "daily") {
    console.log("[intent:audio]", JSON.stringify({ primary: intent.primary, all: intent.intents }));
  }
  const hintBlock = [
    intentHint, repetitionHint, wordGameHint, nameAnswerHint, recallVerifyHint, anomalyHint, familyQueryGuard, infoRequestHint, emergency.hint,
    "[답변 직전 점검]\n사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요. 직전 AI 발화에 사용자가 답을 했다면 그 답을 우선 인정/반영한 뒤 자연스럽게 이어가세요.",
  ].filter((s) => s && s.trim()).join("\n\n");
  const currentUserMsg = transcription || "(음성을 인식하지 못했습니다)";
  const contents = buildChatContents({ messages, currentUserMessage: currentUserMsg, memories, hintBlock });

  const fallback = buildFallbackMessage(honorific, companionName);
  const { text: rawText, fallbackUsed } = await generateWithFallback(model, { contents }, fallback);
  const ctx = `${memories || ""}\n${historyText || ""}\n${transcription || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  let answerText = fallbackUsed ? rawText : stripRecallAnswerLeak(normalizeImnida(removeRepeatedOpening(fixWordChainStart(fixChildGenderHonorific(normalizeFamilyChildHonorific(normalizeHonorific(removeUngroundedClaims(removeParrot(removeTimeLabels(trimIncomplete(rawText)), transcription, companionName), ctx), honorific), ctx), profile.family)), prevAi)));

  // Phase 1 Fact-checker — 음성 응답에도 적용 (텍스트와 동일 수준 안전성)
  if (!fallbackUsed && answerText) {
    const recentUserText = messages.filter((m) => m.role === "user").slice(-6).map((m) => m.content).join(" ");
    const checked = factCheckResponse({ aiText: answerText, profile, recentUserText, memories: memories || "", honorific, companionName, currentUserText: transcription });
    if (checked.cleaned !== answerText) {
      console.warn("[fact-checker:audio] cleaned response. removed:", checked.removed.length);
      answerText = checked.cleaned || answerText;
    }
  }

  if (conversationId) {
    const { userMsgId } = await saveMessages({
      conversationId, userId,
      userContent: transcription || "(음성 메시지)",
      assistantContent: answerText,
      emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
      emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
    });
    // L2 응급은 백그라운드 알림 (LLM은 이미 부드러운 권유 멘트 포함)
    if (emergency.effectiveLevel === 2) {
      notifyGuardian({
        userId, userName: honorific, messageId: userMsgId, level: 2,
        category: emergency.result.category, content: transcription,
        aiReply: answerText, createdAt: new Date(),
      }).then((r) => {
        if (r.sent) console.log("[emergency-notify] L2 sent:", r.channels);
      }).catch((e) => console.error("[emergency-notify] L2 error:", e));
    }
    // 인지 분석은 백그라운드 — 응답 속도에 영향 주지 않음
    runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: transcription, assistantResponse: answerText, historyText, envBlock }).catch((e) => console.error("[bg-cognitive]", e));
    // Phase 1 프로필 추출 — 음성 발화에서도 가족·고향·취미 자동 추출
    if (transcription) {
      extractAndSaveProfile({ userId, userMessage: transcription, userMessageId: userMsgId }).catch((e) => console.error("[bg-profile-extract:audio]", e));
      // Phase 3 요약 트리거
      maybeTriggerSummaryRollup({ userId, conversationId }).catch((e) => console.error("[bg-summary-trigger:audio]", e));
    }
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
    const { userMsgId } = await saveMessages({
      conversationId,
      userId,
      userContent: transcription !== undefined ? (transcription || "(음성 메시지)") : userContent,
      assistantContent: reply,
      emergencyLevel: 3,
      emergencyEvidence: `${result.category}:${result.evidence}`,
    });
    // 보호자 알림 — 백그라운드로 발송 (응답 지연 방지)
    notifyGuardian({
      userId,
      userName: honorific,
      messageId: userMsgId,
      level: 3,
      category: result.category,
      content: (transcription ?? userContent) || "",
      aiReply: reply,
      createdAt: new Date(),
    }).then((r) => {
      if (r.sent) console.log("[emergency-notify] L3 sent:", r.channels);
      else console.log("[emergency-notify] L3 skipped:", r.reason);
    }).catch((e) => console.error("[emergency-notify] L3 error:", e));
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
  profile: FullProfile;
}) {
  const { systemPrompt, envBlock, userId, conversationId, userContent, historyText, memories, messages, companionName, honorific, profile } = params;

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
  const recallVerifyHint = buildRecallVerificationHint(historyText, userContent);
  const anomalyHint = buildAnomalyCorrectionHint(userContent);
  const familyQueryGuard = buildFamilyQueryGuard(userContent, profile.family);
  const infoRequestHint = buildInfoRequestHint(userContent);
  // Phase C: 의도 분류기 — 발화 유형에 따라 prompt 분기 강제
  const intent = classifyIntent(userContent);
  const intentHint = buildIntentHint(intent, honorific);
  if (intent.primary !== "daily") {
    console.log("[intent]", JSON.stringify({ primary: intent.primary, all: intent.intents }));
  }
  const hintBlock = [
    intentHint, repetitionHint, wordGameHint, nameAnswerHint, recallVerifyHint, anomalyHint, familyQueryGuard, infoRequestHint, emergency.hint,
    "[답변 직전 점검]\n사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요. 직전 AI 발화에 사용자가 답을 했다면 그 답을 우선 인정/반영한 뒤 자연스럽게 이어가세요.",
  ].filter((s) => s && s.trim()).join("\n\n");

  const contents = buildChatContents({ messages, currentUserMessage: userContent, memories, hintBlock });

  // DEBUG: 환경변수 DEBUG_INPUT=1 설정 시 입력 dump (사용자 간 데이터 누수 진단용).
  //   2026-05-26 abc→rudtjrch 누수 root cause 추적에 사용됨. 평소엔 off.
  if (process.env.DEBUG_INPUT === "1") {
    console.log("[DEBUG-INPUT]", JSON.stringify({
      userId: userId.slice(0, 12),
      conversationId: conversationId?.slice(0, 12),
      userContent: userContent.slice(0, 200),
      messagesCount: messages.length,
      memoriesPreview: (memories || "").slice(0, 300),
      systemPromptLen: systemPrompt.length,
      profileFamily: profile.family.map((f) => `${f.relation}#${f.orderIdx ?? '-'} ${f.name}`),
    }, null, 2));
  }

  const fallback = buildFallbackMessage(honorific, companionName);
  const { text: rawText, fallbackUsed } = await generateWithFallback(model, { contents }, fallback);
  if (process.env.DEBUG_INPUT === "1") {
    console.log("[DEBUG-RAW-RESPONSE]", JSON.stringify({ rawText: rawText?.slice(0, 500), fallbackUsed }));
  }
  const ctx = `${memories || ""}\n${historyText || ""}\n${userContent || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  let text = fallbackUsed ? rawText : stripRecallAnswerLeak(normalizeImnida(removeRepeatedOpening(fixWordChainStart(fixChildGenderHonorific(normalizeFamilyChildHonorific(normalizeHonorific(removeUngroundedClaims(removeParrot(removeTimeLabels(trimIncomplete(rawText)), userContent, companionName), ctx), honorific), ctx), profile.family)), prevAi)));

  // Phase 1 Fact-checker — 응답에 등장한 이름·고유명사가 profile/이력에 근거 있는지 cross-check.
  //   환각 차단의 마지막 라인 (오늘 abc→rudtjrch 사고 같은 케이스 방지).
  if (!fallbackUsed && text) {
    const recentUserText = messages.filter((m) => m.role === "user").slice(-6).map((m) => m.content).join(" ");
    const checked = factCheckResponse({ aiText: text, profile, recentUserText, memories: memories || "", honorific, companionName, currentUserText: userContent });
    if (checked.cleaned !== text) {
      console.warn("[fact-checker] cleaned response. removed sentences:", checked.removed.length);
      text = checked.cleaned || text; // 모두 삭제되면 fallback 우회용으로 원본 유지
    }
  }

  if (conversationId && userContent) {
    const { userMsgId } = await saveMessages({
      conversationId, userId, userContent, assistantContent: text,
      emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
      emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
    });
    if (emergency.effectiveLevel === 2) {
      notifyGuardian({
        userId, userName: honorific, messageId: userMsgId, level: 2,
        category: emergency.result.category, content: userContent,
        aiReply: text, createdAt: new Date(),
      }).then((r) => {
        if (r.sent) console.log("[emergency-notify] L2 sent:", r.channels);
      }).catch((e) => console.error("[emergency-notify] L2 error:", e));
    }
    // 인지 분석은 백그라운드 — 응답 속도에 영향 주지 않음
    runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: userContent, assistantResponse: text, historyText, envBlock }).catch((e) => console.error("[bg-cognitive]", e));
    // Phase 1 프로필 추출 — 사용자 발화에서 가족·고향·취미 등 자동 추출 (백그라운드)
    extractAndSaveProfile({ userId, userMessage: userContent, userMessageId: userMsgId }).catch((e) => console.error("[bg-profile-extract]", e));
    // Phase 3 요약 트리거 — 메시지 50건+ 누적 시 weekly 생성 + 계층 rollup (백그라운드)
    maybeTriggerSummaryRollup({ userId, conversationId }).catch((e) => console.error("[bg-summary-trigger]", e));
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
    const { systemPrompt, envBlock, userName, honorific, companionName, companionRelation, profile } = await buildSystemPrompt({
      userId, conversationId, timeCtx, weather: weatherCtx,
    });

    if (isInitialGreeting) return handleFirstGreeting(systemPrompt, userName, honorific, companionName, companionRelation, conversationId);
    if (isReturningGreeting) return handleReturningGreeting(systemPrompt, userName, honorific, conversationId);

    const userMessages = messages?.filter((m) => m.role === "user").map((m) => m.content) ?? [];
    const lastUserMessage = userMessages[userMessages.length - 1] ?? "";
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
        audioData: audio.data, audioMimeType: audio.mimeType, historyText, memories, messages: messages ?? [], profile,
      });
    }

    return handleTextMessage({ systemPrompt, envBlock, userId, conversationId, userContent: lastUserMessage, historyText, memories, messages: messages ?? [], companionName, companionRelation, honorific, profile });
  } catch (e) {
    console.error("chat api error", e);
    return NextResponse.json({ error: toSafeError(e) }, { status: 500 });
  }
}
