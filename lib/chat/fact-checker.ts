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

function calculateGrounding(text: string, profile: FullProfile, recentUserText: string, memories: string): number {
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
  if (candidates.size === 0) return 1.0;  // 구체 명사 없으면 신뢰도 100%

  let grounded = 0;
  for (const c of candidates) {
    if (isGrounded(c, profile, recentUserText, memories)) grounded++;
  }
  return grounded / candidates.size;
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
  result.groundingScore = calculateGrounding(aiText, profile, recentUserText, memories);

  // 1) 가족 관계 모순 detect (경고만, 자동 수정은 위험)
  result.warnings.push(...findRelationContradictions(aiText, profile));

  // 2) 응답에서 이름 후보 추출 → 근거 없는 이름 포함 문장 통째 삭제
  const candidates = extractNameCandidates(aiText);
  const ungrounded: string[] = [];
  for (const name of candidates) {
    if (!isGrounded(name, profile, recentUserText, memories)) {
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
      const askedFamilyInfo = /가족|아들|딸|손주|아드님|따님|아내|남편/.test(input.recentUserText) ||
                              /이름|누구|뭐였|기억하|알려/.test(input.recentUserText);
      if (askedFamilyInfo) {
        result.cleaned = `${input.honorific}, 죄송해요. 가족분 정보를 민지가 정확히 알지 못해서요. 혹시 다시 한 번 말씀해주실 수 있으세요?`;
      } else {
        result.cleaned = `${input.honorific}, 민지가 잠시 헷갈렸나 봐요. 다시 한 번 말씀해주실 수 있으세요?`;
      }
    }

    console.warn("[fact-check] removed ungrounded names:", JSON.stringify({
      ungrounded, removed: result.removed.length, warnings: result.warnings,
      finalLength: result.cleaned.length, usedFallback: result.cleaned.length < 80 && result.cleaned.includes("민지가"),
      groundingScore: result.groundingScore.toFixed(2),
    }));
  } else if (result.warnings.length > 0) {
    console.warn("[fact-check] relation warnings:", result.warnings);
  }

  // grounding score 임계값 미달 시 safe fallback — 매우 공격적이라 임계값 낮춤.
  // removeUngroundedClaims가 이미 문장 단위 정교 검증하므로, score는 logging 위주 + 극단치만 fallback.
  if (result.groundingScore < 0.2 && result.cleaned.length > 80) {
    console.warn("[fact-check] very low grounding score, replacing:", result.groundingScore);
    result.cleaned = `${input.honorific}, 민지가 정확히 기억이 안 나는 부분이 있어서요. 다시 한 번 알려주시겠어요?`;
  } else if (result.groundingScore < 0.5) {
    console.log("[fact-check] grounding score (info only):", result.groundingScore.toFixed(2));
  }

  return result;
}
