/**
 * RAG: 과거 대화 임베딩 검색 및 저장.
 * message_embeddings 테이블은 Prisma 스키마에 없고, raw SQL로 접근합니다.
 */

import { prisma } from "@/lib/prisma";
import { embedText } from "@/lib/embedding";
import { getRelativeTimeLabel } from "@/lib/chat/time";

const DEFAULT_LIMIT = 5;

/**
 * 사용자의 과거 메시지 중 쿼리와 유사한 것들을 검색해, 맥락 문자열로 반환합니다.
 * @param userId - 현재 사용자 ID
 * @param queryText - 현재 사용자 메시지 (검색 쿼리)
 * @param limit - 가져올 개수 (기본 5)
 */
export async function searchMemories(
  userId: string,
  queryText: string,
  limit: number = DEFAULT_LIMIT
): Promise<string> {
  if (!queryText.trim()) return "";

  const queryEmbedding = await embedText(queryText.trim(), "RETRIEVAL_QUERY");
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  // pgvector: cosine distance (<=>). 파라미터는 $1, $2, $3로 바인딩 (SQL 인젝션 방지)
  // 이상 발화(isAnomaly=true)와 AI 응답은 제외 — 과거 이상 진술을 현재 사실처럼 재소환하는 것을 방지
  const rows = await prisma.$queryRawUnsafe<{ content_text: string; created_at: Date }[]>(
    `SELECT me.content_text, me.created_at
     FROM message_embeddings me
     LEFT JOIN "Message" m ON m.id = me.message_id
     WHERE me.user_id = $1
       AND (m."isAnomaly" IS DISTINCT FROM true)
       AND (m.role IS NULL OR m.role = 'user')
     ORDER BY me.embedding <=> $2::vector
     LIMIT $3`,
    userId,
    vectorStr,
    limit
  );

  if (!rows?.length) return "";
  const now = new Date();
  return rows
    .map((r) => `[${getRelativeTimeLabel(r.created_at, now)}] ${r.content_text}`)
    .join("\n");
}

/**
 * 메시지 내용을 임베딩해서 message_embeddings 테이블에 저장합니다.
 * 메시지 저장 직후 호출하세요.
 */
export async function saveMessageEmbedding(
  userId: string,
  messageId: string,
  contentText: string
): Promise<void> {
  const trimmed = contentText.trim().slice(0, 2000);
  if (!trimmed) return;

  const embedding = await embedText(trimmed, "RETRIEVAL_DOCUMENT");
  const vectorStr = `[${embedding.join(",")}]`;
  const id = `emb_${messageId}_${Date.now()}`;

  await prisma.$executeRawUnsafe(
    `INSERT INTO message_embeddings (id, user_id, message_id, content_text, embedding, created_at) VALUES ($1, $2, $3, $4, $5::vector, now())`,
    id,
    userId,
    messageId,
    trimmed,
    vectorStr
  );
}
