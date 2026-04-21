import "dotenv/config";
import { buildSystemPrompt } from "../lib/chat/prompt";
import { prisma } from "../lib/prisma";

async function main() {
  const user = await prisma.user.findFirst({ where: { email: "abc@abc.com" } });
  if (!user) { console.log("no user"); return; }
  console.log("User:", { companionName: user.companionName, companionRelation: user.companionRelation });

  const now = new Date();
  const parts = await buildSystemPrompt({
    userId: user.id,
    conversationId: undefined,
    timeCtx: { dateStr: now.toLocaleString("ko-KR"), timeLabel: "낮", now },
    weather: { promptText: "날씨 정보 없음" },
  } as any);
  console.log("\n--- systemPrompt 앞 500자 ---");
  console.log(parts.systemPrompt.slice(0, 500));
  console.log("\ncompanion:", parts.companionName, parts.companionRelation);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
