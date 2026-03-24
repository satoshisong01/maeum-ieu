/** DB 메시지 저장 및 이상징후 기록 */

import { prisma } from "@/lib/prisma";
import { saveMessageEmbedding } from "@/lib/rag";
import { getNowKst } from "./time";

interface SavedMessage {
  id: string;
  content: string;
}

/** 사용자 + AI 메시지를 DB에 저장하고 RAG 임베딩도 비동기 처리 */
export async function saveMessages(params: {
  conversationId: string;
  userId: string;
  userContent: string;
  assistantContent: string;
  isAnomaly: boolean;
  analysisNote: string | null;
}): Promise<{ userMsg: SavedMessage; assistantMsg: SavedMessage }> {
  const { conversationId, userId, userContent, assistantContent, isAnomaly, analysisNote } = params;
  const nowKst = getNowKst();

  const userMsg = await prisma.message.create({
    data: { conversationId, role: "user", content: userContent, createdAt: nowKst },
  });

  const assistantMsg = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: assistantContent,
      isAnomaly,
      analysisNote,
      createdAt: nowKst,
    },
  });

  if (isAnomaly && analysisNote) {
    await prisma.healthLog.create({
      data: {
        userId,
        conversationId,
        type: "cognitive",
        value: "인지 오류 감지",
        note: analysisNote,
      },
    });
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: nowKst },
  });

  // RAG 임베딩 비동기 저장 (실패해도 채팅에 영향 없음)
  saveMessageEmbedding(userId, userMsg.id, userMsg.content).catch((e) =>
    console.warn("RAG embed (user) failed:", e),
  );
  saveMessageEmbedding(userId, assistantMsg.id, assistantMsg.content).catch((e) =>
    console.warn("RAG embed (assistant) failed:", e),
  );

  return { userMsg, assistantMsg };
}

/** AI 인사 메시지만 저장 (초기 인사용) */
export async function saveGreetingMessage(conversationId: string, text: string): Promise<void> {
  const nowKst = getNowKst();
  await prisma.message.createMany({
    data: [{ conversationId, role: "assistant", content: text, createdAt: nowKst }],
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: nowKst },
  });
}
