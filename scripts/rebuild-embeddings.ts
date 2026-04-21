/**
 * Message 테이블의 user 발화만 재임베딩해서 message_embeddings에 저장.
 * 주의: Gemini embedding API 호출이 대량 발생 → 지연 있음.
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { saveMessageEmbedding } from "../lib/rag";

async function main() {
  const users = await prisma.user.findMany({ select: { id: true } });
  let total = 0;
  for (const u of users) {
    const convs = await prisma.conversation.findMany({ where: { userId: u.id }, select: { id: true } });
    for (const c of convs) {
      const msgs = await prisma.message.findMany({
        where: { conversationId: c.id, role: "user" },
        select: { id: true, content: true },
        orderBy: { createdAt: "asc" },
      });
      for (const m of msgs) {
        try {
          await saveMessageEmbedding(u.id, m.id, m.content);
          total++;
          if (total % 50 === 0) console.log(`  ... ${total}건 완료`);
        } catch (e) {
          console.warn(`실패 msg ${m.id}:`, (e as Error).message);
        }
      }
    }
  }
  console.log(`\n✓ 총 ${total}건 재임베딩 완료`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
