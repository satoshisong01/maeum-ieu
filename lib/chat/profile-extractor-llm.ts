/**
 * LLM 기반 정밀 profile extractor — 정규식이 못 잡는 패턴 보완.
 *
 * 호출 조건 (비용 효율):
 *   - 사용자 발화 길이 30자 이상
 *   - 정규식 extractor 결과 0건
 *   - 가족/거주/취미 키워드 포함 ("아들/딸/손주/사위/며느리/집/사는/취미/좋아/먹어/키워")
 *
 * 출력: 정규식 결과와 동일한 JSON 스키마. 환각 위험 막기 위해 결과 검증 후 upsert.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { upsertFamilyMember, upsertFact, upsertProfile, type FamilyRelation } from "./profile";

const TRIGGER_KEYWORDS = /(아들|딸|손주|손자|손녀|사위|며느리|아내|남편|영감|안사람|고향|살아|살고|취미|키워|기르)/;

const LLM_PROMPT = `당신은 노인 사용자 발화에서 가족·일상 사실을 추출하는 분석가입니다.
아래 발화에서 명확한 사실만 추출하세요. 추측·확장 금지.

추출 가능 항목 (JSON):
{
  "family": [{"name": "이름", "relation": "son|daughter|grandchild|spouse|sibling|nephew|niece|parent", "orderIdx": 1|2|3|null, "notes": "특징"}],
  "hometown": "고향",
  "residence": "현 거주지",
  "spouseStatus": "bereaved|alive|null",
  "hobbies": "취미 (콤마 구분)",
  "favoriteFoods": "음식 (콤마 구분)",
  "facts": [{"key": "fact_key", "value": "fact_value"}]
}

규칙:
- 사실이 명확하지 않으면 빈 배열/null
- 가족 이름은 한국어 2~4글자 명사만
- 종결어미(이야/이고/이지)는 이름에서 제거
- "둘째" 단독은 아들/딸 구분 불가 → 명시적일 때만
- 친구 이름은 family에 넣지 마세요

발화: "{USER_MESSAGE}"

JSON으로만 응답하세요.`;

interface ExtractResult {
  familyAdded: string[];
  factsAdded: string[];
  profileUpdated: string[];
}

/** LLM extractor 호출 조건 판단 */
export function shouldUseLLMExtractor(userMessage: string, regexResultCount: number): boolean {
  if (!userMessage || userMessage.length < 30) return false;
  if (regexResultCount > 0) return false;  // 정규식이 잡았으면 LLM 호출 불필요
  if (!TRIGGER_KEYWORDS.test(userMessage)) return false;
  return true;
}

const VALID_RELATIONS: ReadonlyArray<FamilyRelation> = ["son", "daughter", "grandchild", "spouse", "sibling", "nephew", "niece", "parent", "other"];
const NAME_RE = /^[가-힣]{2,4}$/;

/**
 * LLM이 잘못 추출할 수 있는 추상 명사·일반 단어 차단.
 * regex extractor STOPWORD_NAME과 동기화 필요 (2026-05-26 "재미" 누수 사고 대응).
 */
const ABSTRACT_NOUN_BLOCKLIST = new Set([
  "재미", "취미", "행복", "사랑", "마음", "생각", "이야기", "추억", "시간", "진심", "정성", "복덩이",
  "효자", "효녀", "걱정", "근심", "고민", "기쁨", "슬픔", "외로움", "그리움", "고마움", "감사",
  "정", "사정", "사연", "이유", "건강", "기억", "다행", "축복", "복", "꿈", "희망", "용기", "위로",
  "선생님", "회원님", "고객님", "어르신", "아드님", "따님", "할아버지", "할머니",
]);

function cleanName(s: string): string {
  return s.replace(/(?:이야|이고|이지|이며|이에요|예요|이세요|세요|이|가|은|는|을|를|랑|이랑|야)$/, "").trim();
}

function isValidPersonName(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  if (ABSTRACT_NOUN_BLOCKLIST.has(name)) return false;
  return true;
}

export async function extractWithLLM(params: {
  userId: string;
  userMessage: string;
  userMessageId?: string;
}): Promise<ExtractResult> {
  const result: ExtractResult = { familyAdded: [], factsAdded: [], profileUpdated: [] };
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return result;

  try {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: "application/json" },
    });
    const prompt = LLM_PROMPT.replace("{USER_MESSAGE}", params.userMessage.slice(0, 500));
    const res = await model.generateContent(prompt);
    const raw = res.response.text().trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return result;
    const parsed = JSON.parse(raw.slice(start, end + 1));

    // 가족
    if (Array.isArray(parsed.family)) {
      for (const f of parsed.family) {
        if (!f || typeof f.name !== "string" || typeof f.relation !== "string") continue;
        const name = cleanName(f.name);
        if (!isValidPersonName(name)) continue;
        if (!VALID_RELATIONS.includes(f.relation as FamilyRelation)) continue;
        try {
          await upsertFamilyMember(params.userId, {
            name,
            relation: f.relation as FamilyRelation,
            orderIdx: typeof f.orderIdx === "number" ? f.orderIdx : null,
            notes: typeof f.notes === "string" ? f.notes.slice(0, 200) : null,
            sourceMessageId: params.userMessageId ?? null,
          });
          result.familyAdded.push(`${f.relation}:${name}(LLM)`);
        } catch { /* ignore */ }
      }
    }

    // 프로필
    const profilePatch: Record<string, string> = {};
    if (typeof parsed.hometown === "string" && parsed.hometown.length >= 2 && parsed.hometown.length <= 10) profilePatch.hometown = parsed.hometown;
    if (typeof parsed.residence === "string" && parsed.residence.length >= 2 && parsed.residence.length <= 10) profilePatch.residence = parsed.residence;
    if (parsed.spouseStatus === "bereaved" || parsed.spouseStatus === "alive") profilePatch.spouseStatus = parsed.spouseStatus;
    if (typeof parsed.hobbies === "string" && parsed.hobbies.length > 0) profilePatch.hobbies = parsed.hobbies.slice(0, 200);
    if (typeof parsed.favoriteFoods === "string" && parsed.favoriteFoods.length > 0) profilePatch.favoriteFoods = parsed.favoriteFoods.slice(0, 200);
    if (Object.keys(profilePatch).length > 0) {
      try {
        await upsertProfile(params.userId, profilePatch);
        result.profileUpdated.push(...Object.entries(profilePatch).map(([k, v]) => `${k}=${v}(LLM)`));
      } catch { /* ignore */ }
    }

    // facts
    if (Array.isArray(parsed.facts)) {
      for (const fact of parsed.facts) {
        if (!fact || typeof fact.key !== "string" || typeof fact.value !== "string") continue;
        if (fact.key.length > 50 || fact.value.length > 200) continue;
        try {
          await upsertFact(params.userId, { key: fact.key, value: fact.value, confidence: 0.7, sourceMessageId: params.userMessageId ?? null });
          result.factsAdded.push(`${fact.key}=${fact.value}(LLM)`);
        } catch { /* ignore */ }
      }
    }

    if (result.familyAdded.length + result.factsAdded.length + result.profileUpdated.length > 0) {
      console.log("[profile-extract:LLM]", JSON.stringify({ userId: params.userId.slice(0, 8), ...result }));
    }
    return result;
  } catch (e) {
    console.warn("[profile-extract:LLM] error:", (e as Error).message);
    return result;
  }
}
