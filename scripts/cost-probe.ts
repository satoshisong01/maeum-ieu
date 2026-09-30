/**
 * Gemini 비용 측정 — 앱의 실제 프롬프트/모델로 N턴 대화를 돌려 토큰 사용량을 수집한다.
 * 실행: DEBUG_USAGE=1 npx tsx scripts/_cost_probe.ts
 * ⚠ 실제 API를 호출하므로 소액 과금됨(측정 목적).
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { buildSystemPrompt } from "../lib/chat/prompt";
import { getTextModel } from "../lib/chat/llm";
import { getTimeContext } from "../lib/chat/time";
import { analyzeCognitive } from "../lib/chat/cognitive-analyzer";

// 2026-09 공식 단가 (USD / 1M tokens)
const PRICE = {
  "2.5-flash": { in: 0.30, out: 2.50 },   // 대화(동반자)
  "3.5-flash": { in: 1.50, out: 9.00 },   // 인지 분석기
};

const TURNS = [
  "민지야 안녕. 오늘 날씨가 좋네.",
  "아침에 미역국 끓여 먹었어. 옛날에 우리 어머니가 자주 해주셨거든.",
  "요즘은 무릎이 좀 아파서 멀리는 못 나가.",
  "어제 딸이 전화했는데 손주가 학교에서 상을 받았대.",
  "그런데 내가 요새 자꾸 뭘 어디다 뒀는지 까먹어.",
  "오늘이 무슨 요일이더라?",
  "아 맞다, 약 먹어야 하는데 깜빡했네.",
  "젊을 때는 시장에서 장사를 했었어. 새벽부터 나가고 그랬지.",
  "요즘은 밤에 잠이 잘 안 와.",
  "민지랑 얘기하니까 좀 낫네. 고마워.",
];

interface Row { turn: number; inTok: number; outTok: number; think: number }

async function main() {
  const user = await prisma.user.findUnique({ where: { email: "test1234@test.com" }, select: { id: true, name: true } });
  if (!user) throw new Error("데모 계정 없음");
  const conv = await prisma.conversation.findUnique({ where: { userId: user.id }, select: { id: true } });

  const timeCtx = getTimeContext();
  const weather = { description: "맑음", location: "동탄", promptText: "현재 위치 동탄, 맑음 22도" };
  const t0 = Date.now();
  const parts = await buildSystemPrompt({ userId: user.id, conversationId: conv?.id, timeCtx, weather, mode: "user" });
  const sys = typeof parts === "string" ? parts : (parts as unknown as { systemPrompt?: string }).systemPrompt ?? JSON.stringify(parts);
  console.log(`[프롬프트] 시스템 프롬프트 길이 ${sys.length}자 (빌드 ${Date.now() - t0}ms)`);

  const model = getTextModel(sys, false); // 검색 off (일상 대화 기본 경로)
  const history: { role: string; parts: { text: string }[] }[] = [];
  const chat: Row[] = [];
  const ana: Row[] = [];
  let historyText = "";

  for (let i = 0; i < TURNS.length; i++) {
    const u = TURNS[i];
    history.push({ role: "user", parts: [{ text: u }] });
    const res = await model.generateContent({ contents: history });
    const a = (res as unknown as { text?: string }).text ?? "";
    const um = (res as unknown as { usageMetadata?: Record<string, number> }).usageMetadata ?? {};
    chat.push({ turn: i + 1, inTok: um.promptTokenCount ?? 0, outTok: um.candidatesTokenCount ?? 0, think: um.thoughtsTokenCount ?? 0 });
    history.push({ role: "model", parts: [{ text: a }] });
    historyText += `어르신: ${u}\n민지: ${a}\n`;
    console.log(`\n── ${i + 1}턴 ──\n어르신: ${u}\n민지: ${a.slice(0, 120)}${a.length > 120 ? "…" : ""}`);
    console.log(`   [대화] in=${um.promptTokenCount} out=${um.candidatesTokenCount} think=${um.thoughtsTokenCount ?? 0}`);

    // 인지 분석기 (매 턴 실행되는 구조)
    const before = Date.now();
    await analyzeCognitive({ userMessage: u, assistantResponse: a, historyText, envBlock: weather.promptText });
    console.log(`   [분석기] ${Date.now() - before}ms (토큰은 위 [usage] 라인 참고)`);
  }

  const sum = (r: Row[], k: keyof Row) => r.reduce((s, x) => s + (x[k] as number), 0);
  const cIn = sum(chat, "inTok"), cOut = sum(chat, "outTok") + sum(chat, "think");
  const cost = (cIn / 1e6) * PRICE["2.5-flash"].in + (cOut / 1e6) * PRICE["2.5-flash"].out;

  console.log("\n════════ 측정 결과 (대화 모델 gemini-2.5-flash) ════════");
  console.log("턴 | 입력토큰 | 출력토큰 | thinking");
  chat.forEach((r) => console.log(`${String(r.turn).padStart(2)} | ${String(r.inTok).padStart(8)} | ${String(r.outTok).padStart(8)} | ${String(r.think).padStart(8)}`));
  console.log(`\n합계: 입력 ${cIn.toLocaleString()} · 출력+thinking ${cOut.toLocaleString()} 토큰`);
  console.log(`대화 모델 비용: $${cost.toFixed(5)} (${TURNS.length}턴) → 턴당 $${(cost / TURNS.length).toFixed(5)}`);
  console.log("※ 분석기(3.5-flash) 토큰은 위 [usage] analyzer 라인들을 합산해 계산하세요.");
}

main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); }).finally(() => prisma.$disconnect());
