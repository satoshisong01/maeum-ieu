// 요약기 수정안 검증 — responseSchema(JSON) + maxOutputTokens 여유 → 잘림·오염 없이 파싱되는지.
import "dotenv/config";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } from "@google/generative-ai";

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const S = SchemaType;
const SUMMARY_SCHEMA = {
  type: S.OBJECT,
  properties: {
    summary: { type: S.STRING, description: "어르신 발화 중심 자연어 요약(200~400자)" },
    facts: {
      type: S.OBJECT,
      properties: {
        family: { type: S.ARRAY, items: { type: S.OBJECT, properties: { relation: { type: S.STRING }, name: { type: S.STRING }, note: { type: S.STRING } } } },
        hometown: { type: S.STRING },
        residence: { type: S.STRING },
        hobbies: { type: S.ARRAY, items: { type: S.STRING } },
        health: { type: S.ARRAY, items: { type: S.STRING } },
        favorites: { type: S.ARRAY, items: { type: S.STRING } },
        events: { type: S.ARRAY, items: { type: S.OBJECT, properties: { when: { type: S.STRING }, what: { type: S.STRING } } } },
      },
    },
  },
  required: ["summary"],
};

const PROMPT = `당신은 노인 인지 케어 시스템의 대화 요약가입니다. 아래 대화에서 사용자(어르신) 발화만 분석해 summary(자연어 요약 200~400자)와 facts(명확한 정보만, 추측 금지)를 채우세요. AI 응답은 무시.`;

// 긴 실제풍 대화(스트레스)
const transcript = Array.from({ length: 30 }, (_, i) => {
  const u = ["누룽지 끓여 먹었어 속이 편해","무릎이 시큰하고 눈이 침침해 경로당서 고스톱 치지","손주가 다음주 온대 기다려져","텃밭 상추 자랐어 쌈 싸먹어야지","라디오 옛날 노래 반갑더라","된장찌개 끓일까 두부 넣고","고향이 강원도 정선이야","채송화 물 주는 게 낙이야"][i % 8];
  return `[사용자] ${u}\n[AI] 네 할머니 그러셨군요.`;
}).join("\n");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash",
  generationConfig: { temperature: 0.2, maxOutputTokens: 3072, responseMimeType: "application/json", responseSchema: SUMMARY_SCHEMA, thinkingConfig: { thinkingBudget: 512 } },
  safetySettings: SAFETY,
});

const res = await model.generateContent(`${PROMPT}\n\n[대화]\n${transcript}`);
const raw = res.response.text().trim();
console.log("=== raw 길이:", raw.length, "===");
console.log("usage:", JSON.stringify(res.response.usageMetadata));
try {
  const obj = JSON.parse(raw);
  console.log("\n✅ JSON.parse 성공");
  console.log("  summary(", obj.summary?.length, "자):", obj.summary?.slice(0, 100));
  console.log("  facts keys:", Object.keys(obj.facts || {}));
  console.log("  family:", JSON.stringify(obj.facts?.family));
  console.log("  health:", JSON.stringify(obj.facts?.health));
} catch (e) {
  console.log("\n❌ JSON.parse 실패:", e.message);
  console.log("raw 끝부분:", JSON.stringify(raw.slice(-120)));
}
