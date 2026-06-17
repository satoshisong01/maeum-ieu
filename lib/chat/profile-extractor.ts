/**
 * 사용자 발화에서 구조화 사실 자동 추출 → user_profile / family_member / user_fact 슬롯에 저장.
 *
 * 정규식 기반 (LLM 호출 비용 절약). 명확한 패턴만 추출하고 애매한 건 보류.
 * 환각 방지 우선 — false negative > false positive (모르는 건 놔두고 잘못 잡지 말 것).
 */

import { prisma } from "@/lib/prisma";
import { upsertFamilyMember, upsertFact, upsertProfile, type FamilyRelation } from "./profile";
import { shouldUseLLMExtractor, extractWithLLM } from "./profile-extractor-llm";
import { NAME_STOPWORDS_BASE, ABSTRACT_NOUN_BLOCKLIST } from "./name-vocab";

/** 정정 패턴 — "사실 X야 / X 아니라 Y / 잘못 알았어 X야" 등 */
const CORRECTION_PATTERNS: Array<{ pattern: RegExp; relation: FamilyRelation; orderIdx: number | null }> = [
  // "큰아들 A라 했는데 사실 B야"
  { pattern: /(?:큰\s*아들|장남|첫째\s*아들)\s*[가-힣]{2,3}\s*(?:라\s*했|이라\s*했|이라고\s*했)[^.]*?사실\s*([가-힣]{2,3})\s*(?:야|이야|이고)/, relation: "son", orderIdx: 1 },
  { pattern: /(?:둘째\s*아들|차남)\s*[가-힣]{2,3}\s*(?:라\s*했|이라\s*했|이라고\s*했)[^.]*?사실\s*([가-힣]{2,3})\s*(?:야|이야|이고)/, relation: "son", orderIdx: 2 },
  // "사실 큰아들은 Y야 (잘못 알았어)"
  { pattern: /(?:사실|잘못\s*알았|헷갈렸)[^.]*?(?:큰\s*아들|장남)\s*(?:은|이)?\s*([가-힣]{2,3})\s*(?:야|이야|이고)/, relation: "son", orderIdx: 1 },
  { pattern: /(?:사실|잘못\s*알았|헷갈렸)[^.]*?(?:둘째\s*아들|차남|둘째)\s*(?:은|이)?\s*([가-힣]{2,3})\s*(?:야|이야|이고)/, relation: "son", orderIdx: 2 },
  // 딸
  { pattern: /(?:사실|잘못\s*알았|헷갈렸)[^.]*?(?:큰\s*딸|장녀)\s*(?:은|이)?\s*([가-힣]{2,3})\s*(?:야|이야|이고)/, relation: "daughter", orderIdx: 1 },
  // "큰아들 X가 아니라 Y야"
  { pattern: /(?:큰\s*아들|장남)\s*[가-힣]{2,3}\s*(?:가|이)\s*아니라\s*([가-힣]{2,3})\s*(?:야|이야|이고)/, relation: "son", orderIdx: 1 },
];

interface ExtractInput {
  userId: string;
  userMessage: string;
  userMessageId?: string;
}

interface ExtractResult {
  familyAdded: string[];
  factsAdded: string[];
  profileUpdated: string[];
}

/** 친척 관계 → relation + order 매핑. 이름 그룹은 명사 + (이/가/는) + 종결어미 페어를 명시적으로 매칭하여 조사 누출 차단. export: 회귀 테스트용. */
export const RELATION_PATTERNS: Array<{
  pattern: RegExp;
  relation: FamilyRelation;
  orderIdx: number | null;
}> = [
  // "큰아들이 재미야/재미고/재미지/재미예요" — 이름 다음에 명확한 종결어미가 와야 매칭
  { pattern: /(?:큰\s*아들|장남|첫째\s*아들)\s*(?:이|가|은|는)\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이며|이에요|예요|이세요|세요|고|지\b|이라|이래|이거든|이지요|입니다)/, relation: "son", orderIdx: 1 },
  // "둘째/셋째/막내" 단독은 아들/딸 구분 불가 → 명시적 "아들/딸" 필요
  // 조사에 은/는 포함 — "막내아들은 준호야"가 미매칭돼 한 문장 복수 가족("큰딸은 영숙이고 막내아들은 준호야")에서
  // 뒤 가족이 누락되던 갭 fix (2026-06-10 사이클: 준호 미저장 → fact-checker가 이름 답변을 비근거로 제거).
  { pattern: /(?:둘째\s*아들|차남)\s*(?:이|가|은|는)?\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이며|이에요|예요|이세요|세요|고|지\b|이라|이래|이거든|이지요|입니다)/, relation: "son", orderIdx: 2 },
  { pattern: /(?:셋째\s*아들|삼남)\s*(?:이|가|은|는)?\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이며|이에요|예요|이세요|세요|고|지\b|이라|이래|이거든|이지요|입니다)/, relation: "son", orderIdx: 3 },
  { pattern: /(?:막내\s*아들)\s*(?:이|가|은|는)?\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이며|이에요|예요|이세요|세요|고|지\b|이라|이래|이거든|이지요|입니다)/, relation: "son", orderIdx: 9 },
  { pattern: /(?:큰\s*딸|장녀|첫째\s*딸)\s*(?:이|가|은|는)\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이며|이에요|예요|이세요|세요|고|지\b|이라|이래|이거든|이지요|입니다)/, relation: "daughter", orderIdx: 1 },
  { pattern: /(?:둘째\s*딸|차녀|둘째딸)\s*(?:이|가|은|는)?\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이며|이에요|예요|이세요|세요|고|지\b|이라|이래|이거든|이지요|입니다)/, relation: "daughter", orderIdx: 2 },
  { pattern: /(?:막내\s*딸|막내딸)\s*(?:이|가|은|는)?\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이며|이에요|예요|이세요|세요|고|지\b|이라|이래|이거든|이지요|입니다)/, relation: "daughter", orderIdx: 9 },
  // "이름이 X이고" 패턴 — 큰아들/큰딸/둘째 등 이미 매칭된 컨텍스트
  { pattern: /(?:큰\s*아들|장남)(?:의)?\s*(?:이름|성함)(?:은|이)\s*([가-힣]{2,3})/, relation: "son", orderIdx: 1 },
  { pattern: /(?:둘째\s*아들|차남)(?:의)?\s*(?:이름|성함)(?:은|이)\s*([가-힣]{2,3})/, relation: "son", orderIdx: 2 },
  // "큰아들 X는/X가 …" 패턴 — 관계명 + 공백 + 이름 + 조사 (종결어미 무관)
  { pattern: /(?:큰\s*아들|장남)\s+([가-힣]{2,3})(?:는|이는|이가|을|이|가|이고|이며|이지|이야)/, relation: "son", orderIdx: 1 },
  { pattern: /(?:둘째\s*아들|차남)\s+([가-힣]{2,3})(?:는|이는|이가|을|이|가|이고|이며|이지|이야)/, relation: "son", orderIdx: 2 },
  { pattern: /(?:큰\s*딸|장녀)\s+([가-힣]{2,3})(?:는|이는|이가|을|이|가|이고|이며|이지|이야)/, relation: "daughter", orderIdx: 1 },
  { pattern: /(?:둘째\s*딸|차녀|둘째딸)\s+([가-힣]{2,3})(?:는|이는|이가|을|이|가|이고|이며|이지|이야)/, relation: "daughter", orderIdx: 2 },
  // 손주 — "큰 손자가 X" / "X 손자가" / "손주 이름은 X"
  { pattern: /(?:큰\s*손자|첫\s*손자)\s*(?:이|가|은|는)\s*([가-힣]{2,3})\s*(?:야|이야|이고|이지|이에요|예요)/, relation: "grandchild", orderIdx: 1 },
  { pattern: /(?:손주|손자|손녀)\s*(?:이름|성함)(?:은|이)\s*([가-힣]{2,3})/, relation: "grandchild", orderIdx: null },
];

/** 이름 추출 후 종결어미·조사 잔여 제거 (안전망). export: 회귀 테스트용. */
export function cleanName(raw: string): string {
  let name = raw.replace(/(?:이야|이고|이지|이며|이에요|예요|이세요|세요|이|가|은|는|을|를|랑|이랑|야|아|어|었나|였나|이었|였)$/, "").trim();
  // 인용 어미 "라고"가 이름에 흡수된 케이스 보정 — "민호라고"→캡처 "민호라"→"민호".
  // 길이 3 이상일 때만 끝 "라" 제거 (2글자 라-이름 보라/세라/미라 보호). "보라라"(보라+라고)→"보라"도 자연 처리.
  if (name.length >= 3 && name.endsWith("라")) name = name.slice(0, -1);
  return name;
}

/** 거주/고향 패턴 */
const RESIDENCE_PATTERNS: Array<{ pattern: RegExp; key: "residence" | "hometown" }> = [
  { pattern: /(?:지금|현재|요즘)?\s*([가-힣]{2,6}(?:시|군|구|동|읍|면)?)\s*(?:에\s*살아|살고\s*있|에서\s*살)/, key: "residence" },
  { pattern: /([가-힣]{2,6})\s*(?:이|가|은|는)\s*고향(?:이|이야|이지|이에요)/, key: "hometown" },
  { pattern: /고향(?:이|은|은요)?\s*([가-힣]{2,6})(?:이|이야|이지|이에요)/, key: "hometown" },
  { pattern: /([가-힣]{2,6})\s*에서\s*(?:태어났|자랐)/, key: "hometown" },
];

// 거주지 오추출 차단 — "혼자/외롭게 살아요"의 부사는 지명이 아니므로 residence로 저장 금지.
//   (행정구역 접미사가 optional이라 접미사 없는 부사가 그대로 잡혀 프로필 환각을 유발했음.)
const RESIDENCE_STOPWORD = new Set([
  "혼자", "혼자서", "둘이", "셋이", "같이", "함께", "외롭게", "외로이", "쓸쓸히", "조용히",
  "대충", "그냥", "편하게", "편안히", "행복하게", "건강하게", "근근이", "겨우", "여기", "거기",
]);

/** 배우자 사별 패턴 */
const SPOUSE_PATTERNS = [
  /(?:안사람|아내|집사람|마누라|와이프|남편|바깥양반)\s*(?:이|가|은|는)?\s*(?:먼저\s*)?(?:떠난|돌아가신|먼저\s*간|먼저\s*떠나)/,
  /(?:안사람|아내|집사람|마누라|남편)\s*(?:이|가)?\s*(?:없|없어|먼저\s*갔)/,
];

/** 화초·식물 패턴 */
const PLANT_PATTERN = /(?:화분(?:에|을|에는)?|마당(?:에|에는)?|베란다(?:에|에는)?)?\s*([가-힣]{2,5}(?:이랑|랑|과|와))?\s*([가-힣]{2,5})\s*(?:키워|키우고\s*있|심었)/;
// "난" 단독 제거 — "따뜻하난"같은 형용사 어미와 충돌 false positive. "난초"로만 매칭.
const SPECIFIC_PLANTS = /(?:제라늄|백일홍|장미|튤립|난초|선인장|코스모스|국화|해바라기|봉숭아|채송화|관음죽|행운목|동백|진달래|개나리|민들레|벤자민고무나무|아이비)/g;

/** 좋아하는 음식 패턴 — 일반 음식 명사 화이트리스트로 제한해 false positive 차단 */
const FOOD_VOCAB = /(?:김치찌개|된장찌개|순두부찌개|미역국|콩나물국|시래기국|곰탕|설렁탕|갈비탕|육개장|냉면|비빔냉면|물냉면|칼국수|잔치국수|비빔국수|국수|수제비|잡채|불고기|갈비|삼겹살|생선|고등어|꽁치|조기|굴비|장어|회|초밥|김밥|떡국|만두|만둣국|호떡|붕어빵|국밥|비빔밥|덮밥|볶음밥|짜장면|짬뽕|탕수육|마늘쫑|미나리|쌈채소|배추|무|호박|가지|당근|감자|고구마|옥수수|밤|대추|곶감|사과|배|귤|딸기|수박|참외|복숭아|포도|식혜|수정과|커피|차|녹차|보리차|숭늉|누룽지|두부|콩나물|시금치|깍두기|총각김치|열무김치|동치미|장아찌|젓갈|간장|된장|고추장|쌈장)/;
const FAVORITE_FOOD_PATTERN = new RegExp(`(${FOOD_VOCAB.source})\\s*(?:가|이|을|를|는|도)\\s*(?:제일|가장|특히|아주)?\\s*(?:맛있|좋아|좋더|즐겨)`);

// 공통 코어 + 추상명사는 name-vocab.ts 단일 소스 (이전 3벌 중복 통합)
const STOPWORD_NAME = new Set([
  ...NAME_STOPWORDS_BASE,
  ...ABSTRACT_NOUN_BLOCKLIST,
  // 호칭·일반 명사 (이 파일 전용)
  "민지", "오늘", "어제", "지금", "안사람", "아내", "남편", "이름", "성함", "여기", "거기",
  // 술어 명사·직업·용언 어간 — "막내딸은 의사야" 류에서 술어가 이름으로 캡처되는 FP 차단
  //   (적대적 리뷰 2026-06-11: 의사/간호사/시집갔/결혼하/착하 등이 family_member에 저장되던 갭)
  "의사", "간호사", "군인", "회사원", "학생", "부자", "효자", "효녀", "사장", "교사",
  "농부", "어부", "교수", "주부", "백수", "경찰", "소방관", "공무원", "목사", "스님",
  "시집", "시집갔", "장가", "결혼", "결혼하", "농사", "농사짓", "장사",
  "착하", "바쁘", "야무지", "잘생기", "못생기", "듬직", "튼튼", "건강하",
  // 의문문 종결어미·활용형 (가장 흔한 false positive)
  "뭐였", "뭐였지", "뭐였더", "뭐였나", "뭐냐", "뭐예요", "뭐죠", "뭐였을", "뭐였던",
  "누구", "누구지", "누구야", "누군지", "누구냐",
  "어디", "어디지", "어디야", "어딘지", "어디예요",
  "언제", "언제지", "언제야", "언젠지",
  "어떻", "어떻게", "어떤", "어땠",
  "정말", "진짜", "근데", "그래", "그건", "그리고", "그러고",
]);

function isValidName(s: string): boolean {
  if (!s || s.length < 2 || s.length > 4) return false;
  if (STOPWORD_NAME.has(s)) return false;
  // 명백한 일반 명사 제외
  if (/^(있|없|좋|싫|예쁜|좋은|착한|나쁜|많은|적은)/.test(s)) return false;
  // 의문문·종결어미 시작 패턴 (뭐였더, 뭐였지, 어땠더 등)
  if (/^(뭐|누|어디|어떻|언제|왜)/.test(s)) return false;
  // "~였", "~었", "~았" 종결어미로 끝나는 활용형
  if (/(?:였|었|았|났)(?:더|지|나|어|을|던)?$/.test(s)) return false;
  return true;
}

/** 반려동물 — 종(species) 확인 필수로 음식 '두부' 등 false positive 차단. */
const PET_SPECIES_RE = /(고양이|야옹이|냐옹이|반려묘|강아지|멍멍이|반려견|앵무새|잉꼬|거북이|햄스터|토끼|금붕어)/;
// 한글 음절 합성상 "키워"는 "키우"를 부분문자열로 포함 안 함 → 활용형 명시 필요
const PET_OWN_VERB = /(키우|키워|키운|키웠|키울|키웁|기르|길러|기른|기를|입양|들였|들여|데려|분양|반려동물)/;
const PET_NAME_PATTERNS: RegExp[] = [
  /이름(?:은|이)\s*([가-힣]{2,4})/,
  /([가-힣]{2,4})(?:라고|이라고|라는|이라는)\s*(?:불|지었|짓|이름|해)/,
  new RegExp(`${PET_SPECIES_RE.source}\\s+([가-힣]{2,4})(?:를|을|이|가|는|랑|예요|이에요|라고|이라고|라는)`),
];
// pet 이름 전용 stoplist — person-name 블록리스트(음식·추상명사 포함)는 적용 안 함:
// 반려동물 이름은 음식·사물에서 자주 따옴(두부·보리·감자·모찌) → 그것까지 막으면 핵심 사례를 놓침.
const PET_NAME_STOP = new Set(["모르", "모름", "글쎄", "아직", "그냥", "비밀", "없어", "있어", "이름", "여러", "마리", "한마", "그대"]);
const PET_SPECIES_NORM: Record<string, string> = {
  "야옹이": "고양이", "냐옹이": "고양이", "반려묘": "고양이", "멍멍이": "강아지", "반려견": "강아지",
};

function isValidPetName(s: string): boolean {
  if (!s || s.length < 2 || s.length > 4) return false;
  if (PET_NAME_STOP.has(s)) return false;
  if (/^(있|없|좋|싫|많|적|예쁜|착한)/.test(s)) return false;
  if (/(?:였|었|았|났)(?:더|지|나|어|을|던)?$/.test(s)) return false;
  if (/^(뭐|누|어디|어떻|언제|왜)/.test(s)) return false;
  return true;
}

/** 반려동물 추출 (종 + 이름). 종·소유동사 둘 다 있어야 발동. export: 회귀 테스트용. */
export function extractPetFromText(text: string): { species: string; name: string | null } | null {
  const sp = text.match(PET_SPECIES_RE);
  if (!sp) return null;
  if (!PET_OWN_VERB.test(text)) return null;
  const species = PET_SPECIES_NORM[sp[1]] ?? sp[1];
  let name: string | null = null;
  for (let i = 0; i < PET_NAME_PATTERNS.length; i++) {
    const m = text.match(PET_NAME_PATTERNS[i]);
    // species+name 패턴(마지막)은 종이 그룹1, 이름이 그룹2
    const raw = i === PET_NAME_PATTERNS.length - 1 ? m?.[2] : m?.[1];
    if (raw) {
      const cand = cleanName(raw);
      if (isValidPetName(cand)) { name = cand; break; }
    }
  }
  return { species, name };
}

export async function extractAndSaveProfile(input: ExtractInput): Promise<ExtractResult> {
  const result: ExtractResult = { familyAdded: [], factsAdded: [], profileUpdated: [] };
  const text = input.userMessage.trim();
  if (!text || text.length < 4) return result;

  // 0) 정정 패턴 우선 처리 — 같은 relation+orderIdx의 기존 row 삭제 후 새 이름 등록
  for (const { pattern, relation, orderIdx } of CORRECTION_PATTERNS) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const name = cleanName(m[1]);
      if (!isValidName(name)) continue;
      try {
        if (orderIdx != null) {
          // 같은 user + relation + orderIdx 의 기존 row 삭제
          await prisma.$executeRawUnsafe(
            `DELETE FROM family_member WHERE user_id = $1 AND relation = $2 AND order_idx = $3`,
            input.userId, relation, orderIdx,
          );
        }
        await upsertFamilyMember(input.userId, {
          name, relation, orderIdx: orderIdx === 9 ? null : orderIdx,
          sourceMessageId: input.userMessageId ?? null,
        });
        result.familyAdded.push(`${relation}:${name}(#${orderIdx} CORRECTED)`);
      } catch (e) { /* ignore */ }
    }
  }

  // 1) 가족 관계 + 이름 추출 (cleanName으로 종결어미 잔여 안전망)
  for (const { pattern, relation, orderIdx } of RELATION_PATTERNS) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const name = cleanName(m[1]);
      if (isValidName(name)) {
        try {
          await upsertFamilyMember(input.userId, {
            name,
            relation,
            orderIdx: orderIdx === 9 ? null : orderIdx,
            sourceMessageId: input.userMessageId ?? null,
          });
          result.familyAdded.push(`${relation}:${name}${orderIdx ? `(#${orderIdx})` : ""}`);
        } catch (e) { /* dup or other; ignore */ }
      }
    }
  }

  // 2) 거주/고향
  for (const { pattern, key } of RESIDENCE_PATTERNS) {
    const m = text.match(pattern);
    if (m && m[1] && m[1].length >= 2 && m[1].length <= 6 && !STOPWORD_NAME.has(m[1]) && !RESIDENCE_STOPWORD.has(m[1])) {
      try {
        await upsertProfile(input.userId, { [key]: m[1] });
        result.profileUpdated.push(`${key}=${m[1]}`);
      } catch { /* ignore */ }
    }
  }

  // 3) 배우자 사별
  if (SPOUSE_PATTERNS.some((p) => p.test(text))) {
    try {
      // 호칭 추출 — "안사람/아내/집사람/마누라/남편/바깥양반"
      const honorificMatch = text.match(/(안사람|아내|집사람|마누라|와이프|남편|바깥양반)/);
      await upsertProfile(input.userId, {
        spouseStatus: "bereaved",
        spouseName: honorificMatch ? honorificMatch[1] : null,
      });
      result.profileUpdated.push("spouse=bereaved");
    } catch { /* ignore */ }
  }

  // 4) 식물·화초 (특정 화초 명사 매칭)
  const plants = Array.from(new Set(text.match(SPECIFIC_PLANTS) || []));
  if (plants.length > 0) {
    try {
      await upsertFact(input.userId, {
        key: "plant",
        value: plants.join(","),
        confidence: 0.9,
        sourceMessageId: input.userMessageId ?? null,
      });
      result.factsAdded.push(`plant=${plants.join(",")}`);
    } catch { /* ignore */ }
  }

  // 5) 좋아하는 음식 (간단 매칭)
  const foodMatch = text.match(FAVORITE_FOOD_PATTERN);
  if (foodMatch && foodMatch[1] && foodMatch[1].length >= 2 && foodMatch[1].length <= 8) {
    const food = foodMatch[1];
    if (!STOPWORD_NAME.has(food) && !/^(여기|거기|이거|그거)/.test(food)) {
      try {
        await upsertProfile(input.userId, { favoriteFoods: food });
        result.profileUpdated.push(`favoriteFoods=${food}`);
      } catch { /* ignore */ }
    }
  }

  // 6) 반려동물 — 종 확인 필수. user_fact(key='반려동물')로 저장 → 컨텍스트 윈도 무관 프롬프트 상주(회상 견고성)
  const pet = extractPetFromText(text);
  if (pet) {
    const petValue = pet.name ? `${pet.species} ${pet.name}` : pet.species;
    try {
      await upsertFact(input.userId, { key: "반려동물", value: petValue, confidence: 0.85, sourceMessageId: input.userMessageId ?? null });
      result.factsAdded.push(`pet=${petValue}`);
    } catch { /* ignore */ }
  }

  if (result.familyAdded.length + result.factsAdded.length + result.profileUpdated.length > 0) {
    // PII(이름·고향·취미 값) 미로깅 — 건수만
    console.log("[profile-extract]", JSON.stringify({ userId: input.userId.slice(0, 8), family: result.familyAdded.length, facts: result.factsAdded.length, profile: result.profileUpdated.length }));
  }

  // Phase B: 정규식 결과 0건 + 가족·일상 키워드 포함 시 LLM 호출로 보강
  const totalRegexHits = result.familyAdded.length + result.factsAdded.length + result.profileUpdated.length;
  if (shouldUseLLMExtractor(input.userMessage, totalRegexHits)) {
    try {
      const llmResult = await extractWithLLM({ userId: input.userId, userMessage: input.userMessage, userMessageId: input.userMessageId });
      result.familyAdded.push(...llmResult.familyAdded);
      result.factsAdded.push(...llmResult.factsAdded);
      result.profileUpdated.push(...llmResult.profileUpdated);
    } catch (e) { /* LLM 실패해도 응답 흐름에 영향 없음 */ }
  }

  return result;
}
