/**
 * Fact-checker — AI 응답에 등장한 고유명사·이름·관계가 사용자 프로필/대화이력에 근거가 있는지 검증.
 *
 * 환각 차단의 핵심: prompt와 RAG에만 의존하던 사실 관리를 명시적 검증 단계로 보강.
 * 오늘 발견된 사고: rudtjrch 사용자가 abc의 가족명("재미/영민")을 응답으로 받음 → 이런 케이스 차단.
 *
 * 알고리즘:
 *   1. 응답에서 한글 명사 후보 추출 (2~4글자, stopword·일반 가족 호칭 제외)
 *   2. 후보 중 "이름성 명사"만 추림 (가족 관계 동반 패턴: "아드님 X", "X 아드님", "X이는", "X이가" 등)
 *   3. 각 후보가 (a) profile.family[].name (b) 최근 N턴 user 발화 (c) memories(RAG) 중 어디라도 등장하는지 확인
 *   4. 어느 곳에도 없으면 → 그 이름 포함 문장 통째 삭제
 *
 * 또한 가족 순서·관계 모순 검증:
 *   - 응답이 "큰아들 X" 라고 했는데 profile에 X 이 orderIdx=2(둘째)면 → 그 문장 수정 또는 제거
 */

import type { FullProfile } from "./profile";
import { nameSubj } from "./korean-particle";

const HONORIFIC_TAG = /(?:아드님|따님|손자|손녀|아들|딸|장남|차남|장녀|차녀|첫째|둘째|셋째|넷째|막내)/;

const NAME_CONTEXT_PATTERNS: RegExp[] = [
  // "X 아드님", "X 따님" 등 — 호칭 앞 이름
  new RegExp(`([가-힣]{2,4})\\s*${HONORIFIC_TAG.source}`, "g"),
  // "아드님 X", "큰아드님 X 등 — 호칭 뒤 이름
  new RegExp(`${HONORIFIC_TAG.source}\\s*(?:은|는|이|가|이름은?|성함은?)?\\s*([가-힣]{2,4})(?:이고|이며|이지|이고요|이에요|예요|이|이세요|세요|이시|시)`, "g"),
  // "X이가/X이는/X이도" — 친근 종조사
  /([가-힣]{2,4})(?:이가|이는|이도|이야)/g,
];

const NAME_STOPWORDS = new Set([
  // 호칭·가족 관계 (false positive 차단)
  "할아버지", "할머니", "민지", "안사람", "아내", "남편", "엄마", "아빠", "어머니", "아버지",
  "아드님", "따님", "손자", "손녀", "큰아들", "둘째", "막내", "장남", "차남", "장녀", "차녀",
  "선생님", "회원님", "고객님", "어르신",
  // 일반 명사·대명사
  "오늘", "어제", "그때", "이때", "여기", "거기", "정말", "민지가", "성함", "이름", "기억",
  // 조사+종결어미 잔여
  "아버지의", "어머니의", "할아버지의", "할머니의", "민지의",
]);

const HONORIFIC_BASE: Record<string, string[]> = {
  "아드님": ["아들", "큰아들", "둘째아들", "장남", "차남", "막내아들"],
  "따님": ["딸", "큰딸", "둘째딸", "장녀", "차녀", "막내딸"],
  "손자": ["손주", "손자"],
  "손녀": ["손주", "손녀"],
};

interface CheckInput {
  aiText: string;
  profile: FullProfile;
  recentUserText: string;   // 최근 N턴 user 발화 join
  memories: string;          // RAG retrieve 결과
  honorific: string;         // 사용자 호칭 (할아버지 등)
  companionName?: string;    // 동반자 이름 (지윤 등) — fallback 멘트에서 자기 호칭으로 사용. 누락 시 "민지" 기본.
  currentUserText?: string;  // 직전 사용자 발화 — 공감/일상 패턴이면 grounding fallback 적용 제외
}

interface CheckResult {
  cleaned: string;
  removed: string[];         // 삭제된 문장
  warnings: string[];        // 모순 발견
  groundingScore: number;    // 0~1, 응답에 등장한 사실명사가 근거 있는 비율
}

/**
 * 응답 grounding 점수 계산 — 응답에 등장한 구체 명사(이름/장소/사물) 중
 * profile/이력/RAG에 근거 있는 비율. 0.5 미만이면 응답 신뢰도 낮음.
 */
const FACT_NOUN_PATTERN = /([가-힣]{2,4})(?:이는|이가|이도|이를|이에게|이한테|아드님|따님|손주|손자|손녀|동네|시|구|동|읍|면|병원|약국|할머니|할아버지)/g;
const COMMON_PLACES = new Set([
  "동탄", "서울", "부산", "대구", "인천", "광주", "대전", "울산", "수원", "성남",
  "고양", "용인", "화성",
]);
const COMMON_FAMILY_LABELS = new Set([
  "아들", "딸", "손주", "손자", "손녀", "아내", "남편", "엄마", "아빠", "어머니", "아버지",
  "큰아들", "둘째", "막내", "큰딸", "장남", "차남", "장녀", "차녀",
  // 배우자 호칭
  "영감", "영감님", "안사람", "와이프", "마누라", "집사람", "여편네", "바깥양반", "주인양반",
  // 일반 호명
  "할머니", "할아버지", "선생님", "어르신", "민지", "수진", "수지",
]);

/**
 * grounding 결과 — score 외에 구체 명사 후보 수(total)와 ungrounded 수도 반환.
 * wholesale fallback이 "노이즈성 단일 명사"로 오발동하지 않도록 호출부에서 total을 게이트로 사용.
 */
interface GroundingDetail {
  score: number;
  total: number;       // 검사 대상 구체 명사 후보 수
  ungrounded: number;  // 근거 없는 후보 수
}

function calculateGrounding(text: string, profile: FullProfile, recentUserText: string, memories: string): GroundingDetail {
  const candidates = new Set<string>();
  let m: RegExpExecArray | null;
  FACT_NOUN_PATTERN.lastIndex = 0;
  while ((m = FACT_NOUN_PATTERN.exec(text)) !== null) {
    const noun = m[1];
    if (!noun || noun.length < 2) continue;
    if (NAME_STOPWORDS.has(noun)) continue;
    if (COMMON_FAMILY_LABELS.has(noun)) continue;
    if (COMMON_PLACES.has(noun)) continue;
    candidates.add(noun);
  }
  if (candidates.size === 0) return { score: 1.0, total: 0, ungrounded: 0 };  // 구체 명사 없으면 신뢰도 100%

  let grounded = 0;
  for (const c of candidates) {
    if (isGrounded(c, profile, recentUserText, memories)) grounded++;
  }
  return { score: grounded / candidates.size, total: candidates.size, ungrounded: candidates.size - grounded };
}

/** 응답에서 이름 후보 추출 (가족 관계 컨텍스트 있는 명사만) */
function extractNameCandidates(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of NAME_CONTEXT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const cand = m[1];
      if (!cand) continue;
      if (NAME_STOPWORDS.has(cand)) continue;
      if (/^(있|없|좋|싫|예쁜|좋은|착한|나쁜|많은|적은|크|작)/.test(cand)) continue;
      out.add(cand);
    }
  }
  return out;
}

/** 후보 이름에서 종조사·계사 잔여 제거 (민호이/민호이시/민호이지/민호이고 → 민호) */
function stripNameSuffix(name: string): string {
  return name.replace(/(?:이고|이며|이지|이야|이세요|이시|이에요|예요|입니다|이라|이래|이거든|이다|이$)$/, "").trim();
}

/** 한 후보가 profile/이력/RAG 어디든 등장하는지 확인 (종조사 잔여 허용) */
function isGrounded(name: string, profile: FullProfile, recentUserText: string, memories: string): boolean {
  const candidates = new Set([name, stripNameSuffix(name)]);
  for (const cand of candidates) {
    if (!cand || cand.length < 2) continue;
    if (profile.family.some((m) => m.name === cand)) return true;
    if (profile.profile?.spouseName === cand) return true;
    if (recentUserText.includes(cand)) return true;
    if (memories.includes(cand)) return true;
  }
  return false;
}

/**
 * 가족 컨텍스트(아드님/따님/큰아들 등)에 등장한 이름이 grounded인지.
 *
 * Why: 2026-05-27 abc 계정에서 옛 message_embeddings의 "재미" 이름이 RAG retrieve로
 *      흘러나와 응답에 "큰아드님 이름은 재미"로 출력되는 회귀 재발.
 *
 * 인정 기준 (RAG memories는 제외 — 옛 데이터 누수 차단):
 *   1) family_member에 등록 OR
 *   2) spouseName 일치 OR
 *   3) recentUserText (최근 user 발화)에 사용자가 직접 언급
 *      → 사용자가 방금 처음 알려준 이름도 인정 (background extractor가 등록하기 전이라도)
 */
function isFamilyContextGrounded(name: string, profile: FullProfile, recentUserText: string): boolean {
  const candidates = new Set([name, stripNameSuffix(name)]);
  for (const cand of candidates) {
    if (!cand || cand.length < 2) continue;
    if (profile.family.some((m) => m.name === cand)) return true;
    if (profile.profile?.spouseName === cand) return true;
    if (recentUserText.includes(cand)) return true;
  }
  return false;
}

/** 가족 관계 모순 검증 — 응답에서 "큰아들 X" 라고 하는데 profile에서 X가 둘째인 경우 */
function findRelationContradictions(text: string, profile: FullProfile): string[] {
  const warnings: string[] = [];
  const ORDER_TAGS: Array<{ tag: RegExp; expected: number }> = [
    { tag: /(?:큰|장(?:남|녀)|첫째)/, expected: 1 },
    { tag: /둘째|차(?:남|녀)/, expected: 2 },
    { tag: /셋째/, expected: 3 },
  ];
  const RELATION_TAGS: Array<{ tag: RegExp; relation: string }> = [
    { tag: /아드님|아들/, relation: "son" },
    { tag: /따님|딸/, relation: "daughter" },
  ];

  // 패턴: "큰 아드님 X" 또는 "X 아드님 (첫째)"
  for (const { tag: orderTag, expected } of ORDER_TAGS) {
    for (const { tag: relTag, relation } of RELATION_TAGS) {
      const re = new RegExp(`${orderTag.source}\\s*${relTag.source}\\s*(?:은|는|이|가|이름은?|성함은?)?\\s*([가-힣]{2,4})`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (!name || NAME_STOPWORDS.has(name)) continue;
        const member = profile.family.find((f) => f.name === name && f.relation === relation);
        if (member && member.orderIdx != null && member.orderIdx !== expected) {
          warnings.push(`relation_mismatch:${name} expected_order=${expected} actual=${member.orderIdx}`);
        }
      }
    }
  }
  return warnings;
}

export function factCheckResponse(input: CheckInput): CheckResult {
  const { aiText, profile, recentUserText, memories } = input;
  const result: CheckResult = { cleaned: aiText, removed: [], warnings: [], groundingScore: 1.0 };
  if (!aiText) return result;

  // Phase A: grounding score 계산
  const grounding = calculateGrounding(aiText, profile, recentUserText, memories);
  result.groundingScore = grounding.score;

  // 1) 가족 관계 모순 detect (경고만, 자동 수정은 위험)
  result.warnings.push(...findRelationContradictions(aiText, profile));

  // 2) 응답에서 이름 후보 추출 → 근거 없는 이름 포함 문장 통째 삭제
  // 가족 컨텍스트 이름은 family_member 또는 사용자 직접 발화에서만 grounded (RAG memories 제외)
  // Why: 2026-05-27 abc cycle에서 옛 message_embeddings의 "재미"가 흘러나옴
  // 단, 사용자가 사망인물·비현실을 언급한 경우 AI가 정정 응답에 그 이름을 호명해야 하므로
  // 이름 후보로 매칭됐어도 사용자 발화에 등장한 이름이면 ungrounded 처리 안 함.
  const candidates = extractNameCandidates(aiText);
  const ungrounded: string[] = [];
  // 동반자(AI) 자기 이름은 항상 grounded — "지윤이도 놀랄 거예요" 같은 자기지칭을 가족 이름으로 오판해
  // 문장째 삭제하던 결함 방지(2026-06-01 라이브: 커스텀 이름 "지윤" 응답이 공백화). 기본 "민지"는 stopword에 이미 포함.
  const selfName = input.companionName ? stripNameSuffix(input.companionName) : "";
  for (const name of candidates) {
    if (selfName && stripNameSuffix(name) === selfName) continue;
    if (!isFamilyContextGrounded(name, profile, recentUserText)) {
      // 사용자가 그 이름을 직접 발화한 경우 (사망인물 정정 등) — 보존
      if (input.currentUserText && input.currentUserText.includes(stripNameSuffix(name))) continue;
      ungrounded.push(name);
    }
  }

  if (ungrounded.length > 0) {
    // 근거 없는 이름이 포함된 문장 삭제
    const sentences = aiText.split(/(?<=[.!?~])\s+/);
    const kept: string[] = [];
    for (const s of sentences) {
      const containsUngrounded = ungrounded.some((n) => s.includes(n));
      if (containsUngrounded) {
        result.removed.push(s);
      } else {
        kept.push(s);
      }
    }
    result.cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();

    // 너무 많이 잘려서 응답이 짧아지면(20자 미만), 안전한 fallback 메시지로 대체.
    // "재미/영민" 같은 환각 이름이 응답의 핵심이었을 때 깨진 결과 노출 방지.
    if (result.cleaned.length < 20) {
      const selfSubj = nameSubj(input.companionName || "민지");  // "지윤이가" / "민지가"
      const askedFamilyInfo = /가족|아들|딸|손주|아드님|따님|아내|남편/.test(input.recentUserText) ||
                              /이름|누구|뭐였|기억하|알려/.test(input.recentUserText);
      if (askedFamilyInfo) {
        result.cleaned = `${input.honorific}, 죄송해요. 가족분 정보를 ${selfSubj} 정확히 알지 못해서요. 혹시 다시 한 번 말씀해주실 수 있으세요?`;
      } else {
        result.cleaned = `${input.honorific}, ${selfSubj} 잠시 헷갈렸나 봐요. 다시 한 번 말씀해주실 수 있으세요?`;
      }
    }

    console.warn("[fact-check] removed ungrounded names:", JSON.stringify({
      ungroundedCount: ungrounded.length, removed: result.removed.length, warningCount: result.warnings.length, // PII(이름) 미로깅
      finalLength: result.cleaned.length, usedFallback: result.cleaned.length < 80 && result.cleaned.includes("헷갈렸나 봐요"),
      groundingScore: result.groundingScore.toFixed(2),
    }));
  } else if (result.warnings.length > 0) {
    console.warn("[fact-check] relation warnings:", result.warnings);
  }

  // grounding score 임계값 미달 시 safe fallback — 매우 공격적이라 임계값 낮춤.
  // removeUngroundedClaims가 이미 문장 단위 정교 검증하므로, score는 logging 위주 + 극단치만 fallback.
  // 공감·일상 발화 + 사용자가 직접 사실을 제공·확인 요청하는 경우는 fallback 적용 제외.
  // Why: 2026-05-26 cycle에서 "재미가 없어"/"민호라고 했었지?" 같은 발화에 회피 답변 회귀.
  const currentUser = input.currentUserText || "";
  const isEmotionalOrCasual = currentUser.length <= 45 && (
    /외로|우울|쓸쓸|허전|슬프|속상|짜증|답답|화나|기분|마음|재미|취미|심심|적적|울적|무료|기운|힘들|피곤|지친|괜찮|좋|싫/.test(currentUser) ||
    /아파|시려|쑤셔|뻐근|결리|어지|두통|불편|찌릿/.test(currentUser) ||
    /고맙|감사|사랑해|예뻐|기뻐|즐거|행복|반가|뿌듯|뭉클|보고\s*싶|그리|챙겨|너\s*없으면|너\s*때문에|덕분에/.test(currentUser)
  );
  // 사용자가 가족 정보 제공/확인 패턴 (이름 명시 + "라고 했/맞아/맞지/그렇지") — 사용자가 친 정보를 AI가 받아주는 케이스
  const userProvidedFact = /(?:아들|딸|손주|손자|손녀|며느리|사위|아내|남편|영감|안사람)[^.]{0,15}(?:이름|성함)?\s*(?:이|가|은|는)?\s*[가-힣]{2,4}(?:이?(?:라고|이라고|이야|이지|이고|이에요|이라|이래)|\s*맞|\s*지)/.test(currentUser);
  // 응급 발화 키워드 — 사용자가 신체 사고·증상·자해의도를 호소한 경우 fallback 절대 금지 (회피 답변 = 매우 위험)
  const isEmergencyOrSafety = /미끄러|넘어져|쓰러져|쓰러졌|다쳤|부러|피가|코피|숨\s*막|숨이\s*안|가슴(?:이|을)?\s*(?:아|답답|조여|찢|쪼개|짓눌|터질)|식은땀|어지러|119|구급|약\s*(?:잘못|많이|두\s*번|또)|토하|죽고\s*싶|뛰어내|목\s*매|끝내(?:버리|고\s*싶|려)|사라(?:지|져)\s*(?:고\s*싶|버리|버려)|살기\s*싫|그만\s*살|살아서\s*뭐|살아\s*뭐|짐(?:만|이|이만)\s*(?:되|돼)|폐(?:만|를)\s*끼치|빨리\s*(?:가야|가버려)|얼른\s*죽어/.test(currentUser);
  // wholesale 교체는 "구체 명사가 충분히 많고(>=3) 그 대부분이 근거 없음"일 때만 — 진짜 환각 밀집 응답 신호.
  // Why: 명사 1~2개만 매칭돼 0/1=0.0 score가 나오는 노이즈 케이스에 정상 응답이 통째로 nuke되어
  //      "방금 말씀을 자세히 알려주세요" 같은 회피성 re-ask로 오발동하던 결함(2026-05-29 라이브 재현).
  //      정밀 검출(removeUngroundedClaims)이 이미 이름 단위로 처리하므로, 여기선 다수 ungrounded 명사일 때만 backstop.
  const denseUngrounded = grounding.total >= 3 && grounding.ungrounded >= 3;
  if (result.groundingScore < 0.15 && denseUngrounded && result.cleaned.length > 120 && !isEmotionalOrCasual && !userProvidedFact && !isEmergencyOrSafety) {
    console.warn("[fact-check] very low grounding score, replacing:", result.groundingScore,
      JSON.stringify({ total: grounding.total, ungrounded: grounding.ungrounded }));
    result.cleaned = `${input.honorific}, ${nameSubj(input.companionName || "민지")} 다시 한 번 여쭤볼게요. 방금 말씀하신 내용을 좀 더 자세히 알려주실 수 있으세요?`;
  } else if (result.groundingScore < 0.5) {
    console.log("[fact-check] grounding score (info only):", result.groundingScore.toFixed(2));
  }

  return result;
}
