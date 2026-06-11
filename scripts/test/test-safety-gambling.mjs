// 도박어 안전차단 격리 테스트 — BLOCK_NONE이 화투/고스톱 차단을 푸는지 API 레벨에서 직접 확인.
import "dotenv/config";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const MSG = "눈이 침침해서 화투 패가 잘 안 보여. 그래도 친구들이랑 고스톱 치는 재미로 경로당 간다니까.";
const SYS = "너는 어르신의 다정한 손녀 수진이다. 어르신 말씀에 따뜻하게 공감하며 짧게 대화한다.";

async function run(label, withSafety) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash",
    systemInstruction: SYS,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 512 } },
    ...(withSafety ? { safetySettings: SAFETY } : {}),
  });
  try {
    const res = await model.generateContentStream(MSG);
    let text = "";
    let finishReason = null;
    let safetyRatings = null;
    for await (const chunk of res.stream) {
      const cand = chunk?.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      if (cand?.safetyRatings) safetyRatings = cand.safetyRatings;
      try {
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) text += parts.filter((p) => !p?.thought && typeof p?.text === "string").map((p) => p.text).join("");
      } catch (e) { /* blocked chunk */ }
    }
    const agg = await res.response;
    console.log(`\n[${label}] withSafety=${withSafety}`);
    console.log("  finishReason:", finishReason || agg?.candidates?.[0]?.finishReason);
    console.log("  promptFeedback:", JSON.stringify(agg?.promptFeedback || null));
    const blocked = (safetyRatings || agg?.candidates?.[0]?.safetyRatings || []).filter((r) => r.blocked || r.probability === "HIGH" || r.probability === "MEDIUM");
    console.log("  blockedRatings:", JSON.stringify(blocked));
    console.log("  text:", text ? text.slice(0, 160) : "(EMPTY)");
  } catch (e) {
    console.log(`\n[${label}] withSafety=${withSafety} → ERROR:`, e.message?.slice(0, 200));
  }
}

await run("no-safety", false);
await run("BLOCK_NONE", true);
