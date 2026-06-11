/** 응답 후처리 — route.ts에서 분리(2026-06-10). 순수 텍스트 변환만: DB/LLM 의존성 없음. 동작 변경 없음. */

import type { FullProfile } from "@/lib/chat/profile";
import { normalizeImnida, stripRecallAnswerLeak, eunNeun, iGa, eulReul, gwaWa } from "@/lib/chat/korean-particle";

/**
 * 앵무새 반응 제거 — AI 응답의 첫 문장이 사용자 발화 핵심 단어를 과도하게 반복하면 그 문장 삭제.
 * 예: 사용자 "된장찌개에 무랑 두부 넣어서" → AI 첫 문장 "된장찌개에 무랑 두부까지 넣어서 끓이셨다니..." → 제거
 */
export function removeParrot(aiText: string, userText: string, companionName: string = "민지"): string {
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
export function removeTimeLabels(text: string): string {
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
export function normalizeHonorific(text: string, userHonorific: string = "할아버지"): string {
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
    out = out.replace(kinPat, (m: string, _g1: string, offset: number, full: string) => {
      // 호격(친족어 뒤 쉼표 = 사용자 직접 호칭)에서만 치환. 그 외(주어·3인칭 가족 지칭: "어머니께서 살아계실 때",
      // "꿈에서 어머니와")는 보존 — referent 혼동(어머니→할머니) 방지.
      const after = full.slice(offset + m.length);
      return /^\s*,/.test(after) ? userHonorific : m;
    });
  }
  const titleOffenders = filter(TITLE).sort((a, b) => b.length - a.length);
  if (titleOffenders.length > 0) {
    const titles = titleOffenders.map(esc).join("|");
    // (?<![가-힣][ \t])(?<![가-힣]): 같은 줄에서 한글 단어(이름)가 바로 앞에 오면 3인칭 지칭
    //   ("김구 선생님")이므로 치환 금지 — "김구 할머니은" 치환+조사 깨짐 방지(2026-06-10 사이클).
    //   개행은 단어 연속이 아니므로 [ \t]만 — "…잘하셨어요\n선생님은" 같은 줄바꿈 직후 호칭은 치환.
    // 조사: 받침 의존 조사(은/는/이/가/을/를/과/와)는 치환어 받침에 맞춰 교정,
    //   받침 무관 조사(께서/께/도/만/의/한테/에게/랑/처럼)는 그대로 이어붙임(HEAD 동작 복원).
    //   조사 뒤에 한글이 이어지면("선생님이세요") 어미이므로 조사로 취급하지 않음.
    // 복합 조사(께서는/한테도 등)는 긴 형태를 먼저 매칭(alternation 순서 의존).
    const PARTICLES = "께서는|께서도|께서만|께서|께는|께도|께|한테는|한테도|한테|에게는|에게도|에게|은|는|이|가|을|를|과|와|도|만|의|랑|처럼";
    const titlePat = new RegExp(
      `(?<![가-힣][ \\t])(?<![가-힣])(${titles})(${PARTICLES})?(?![가-힣])`,
      "g",
    );
    out = out.replace(titlePat, (_m: string, _t: string, p: string | undefined) => {
      if (!p) return userHonorific;
      if (p === "은" || p === "는") return eunNeun(userHonorific);
      if (p === "이" || p === "가") return iGa(userHonorific);
      if (p === "을" || p === "를") return eulReul(userHonorific);
      if (p === "과" || p === "와") return gwaWa(userHonorific);
      return userHonorific + p; // 받침 무관 조사(복합 포함)는 그대로 이어붙임
    });
    // 호격(직후 쉼표/문장부호/끝) — 직접 호칭이 확실하므로 선행 단어와 무관하게 치환.
    //   "안녕하세요 선생님!" / "네 선생님~" 류가 위 lookbehind에 걸려 누출되던 갭 보완(KIN 분기와 동일 기준).
    const vocativePat = new RegExp(`(${titles})(?=\\s*(?:[,!?~.]|$))`, "g");
    out = out.replace(vocativePat, userHonorific);
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
export function fixChildGenderHonorific(text: string, family: Array<{ name: string; relation: string }>, ctx: string = ""): string {
  if (!text) return text;
  // DB 프로필 + 현재 문맥의 명시적 성별 단서 병합 — 방금 소개돼 프로필에 없는 가족("큰딸 영숙이" 등)도 정정.
  const all: Array<{ name: string; relation: string }> = [...(family || [])];
  if (ctx) {
    const dPat = /(?:큰딸|작은딸|막내딸|장녀|차녀|딸)\s*([가-힣]{2,3}?)(?:이가|이는|이도|이라|이고|이야|이에요|예요|이|가|은|는|랑|이랑|을|를|$|\s)/g;
    const sPat = /(?:큰아들|작은아들|막내아들|장남|차남|아들|손자)\s*([가-힣]{2,3}?)(?:이가|이는|이도|이라|이고|이야|이에요|예요|이|가|은|는|랑|이랑|을|를|$|\s)/g;
    let mm: RegExpExecArray | null;
    while ((mm = dPat.exec(ctx)) !== null) all.push({ name: mm[1], relation: "daughter" });
    while ((mm = sPat.exec(ctx)) !== null) all.push({ name: mm[1], relation: "son" });
  }
  if (all.length === 0) return text;
  let out = text;
  for (const f of all) {
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

export function normalizeFamilyChildHonorific(text: string, ctx: string): string {
  if (!text || !ctx) return text;
  const familiar = new Set<string>();
  // 1) 친근 종조사로 호명된 이름 (받침 있는 이름: "영민이가/영민이는")
  const familiarPattern = /([가-힣]{2,3})(?:이가|이는|이도|이야|이를|이랑|이한테|이에게|야\s)/g;
  let m: RegExpExecArray | null;
  while ((m = familiarPattern.exec(ctx)) !== null) {
    familiar.add(m[1]);
  }
  // 2) 가족 관계 + 이름 패턴 (받침 없는 이름까지 포함: "큰아들이 재미", "둘째가 영민")
  //    이름 캡처는 lazy({2,3}?) + 조사를 trailing에 명시 분리 — 이전엔 greedy라 "큰아들 재미는"의
  //    조사 '는'을 이름에 흡수("재미는")해 '씨' 제거가 실패했음.
  const familyRelationPattern = /(?:큰?아들|장남|차남|막내아들|딸|장녀|차녀|막내딸|첫째|둘째|셋째|넷째|막내|손자|손녀|아내|남편)(?:이?|가|는|이름은?|은|이름이)\s*([가-힣]{2,3}?)(?:이고|이며|이지|이야|이에요|예요|야|은|는|이|가|을|를|고|$|\s)/g;
  while ((m = familyRelationPattern.exec(ctx)) !== null) {
    familiar.add(m[1]);
  }
  if (familiar.size === 0) return text;

  let out = text;
  for (const name of familiar) {
    // "이름 씨" + 조사(가/는/이/도/를/랑/한테/에게)
    const pattern = new RegExp(`${name}\\s*씨(?=\\s*(?:가|는|이|도|를|랑|한테|에게|의|와|과)?)`, "g");
    // 안전한 기본: "OO 씨" → "OO" (조사는 그대로)
    out = out.replace(pattern, () => name);
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

export function removeUngroundedClaims(aiText: string, context: string): string {
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

export function fixWordChainStart(text: string): string {
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

export function removeRepeatedOpening(aiText: string, prevAiText: string): string {
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
export function trimIncomplete(text: string): string {
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

/**
 * 응답 후처리 파이프라인 — 11단 변환을 명시적 순서로 실행 + 단계별 관측.
 * 기존 중첩 1줄 호출(양 핸들러 중복)을 단일화. 어떤 단계가 응답을 통째로 비우면 로깅(빈응답 버그 원인 추적).
 * 순서는 load-bearing이므로 변경 주의(removeUngroundedClaims/removeParrot이 빈 문자열을 만들 수 있어 호출부 가드 필수).
 */
export function postProcessReply(
  rawText: string,
  opts: { userText: string; companionName: string; ctx: string; honorific: string; family: FullProfile["family"]; prevAi: string },
): string {
  const { userText, companionName, ctx, honorific, family, prevAi } = opts;
  const stages: Array<[string, (t: string) => string]> = [
    ["trimIncomplete", (t) => trimIncomplete(t)],
    ["removeTimeLabels", (t) => removeTimeLabels(t)],
    ["removeParrot", (t) => removeParrot(t, userText, companionName)],
    ["removeUngroundedClaims", (t) => removeUngroundedClaims(t, ctx)],
    ["normalizeHonorific", (t) => normalizeHonorific(t, honorific)],
    ["normalizeFamilyChildHonorific", (t) => normalizeFamilyChildHonorific(t, ctx)],
    ["fixChildGenderHonorific", (t) => fixChildGenderHonorific(t, family, ctx)],
    ["fixWordChainStart", (t) => fixWordChainStart(t)],
    ["removeRepeatedOpening", (t) => removeRepeatedOpening(t, prevAi)],
    ["normalizeImnida", (t) => normalizeImnida(t)],
    ["stripRecallAnswerLeak", (t) => stripRecallAnswerLeak(t)],
  ];
  let text = rawText;
  for (const [name, fn] of stages) {
    const before = text;
    text = fn(text);
    if (before.trim() && !text.trim()) {
      console.warn(`[post-process] '${name}' 단계가 응답을 빈 문자열로 만듦(직전 길이 ${before.length}) → 호출부 fallback 가드 작동`);
    }
  }
  return text;
}
