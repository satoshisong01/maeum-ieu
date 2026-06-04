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

  // 키워드 추출 — query에서 2글자 이상 한글 명사 후보(공통 stopword 제외, 조사 제거)
  const STOP = new Set(["할아버지", "할머니", "민지", "오늘", "어제", "지금", "그거", "이거", "저거",
    "정말", "다시", "한번", "그런", "이런", "저런", "근데", "그리고", "그래서", "그때", "이때", "되었",
    "하셨", "이에", "있어", "있지", "맞아", "그게", "이게", "저게", "조금", "많이", "좋아", "잠깐",
    "내가", "너는", "내일", "이번", "지난", "그래", "거지", "뭐지", "뭐가", "어떤", "어떻"]);
  // 자주 쓰이는 조사 끝부분 제거 (화분도 → 화분, 마당에 → 마당)
  // 조사 + 복수형 + 흔한 동사 어미 제거
  const stripParticle = (w: string) => {
    const s = w.replace(/(?:이랑|에서|으로|에게|한테|라고|이라|들이|들을|들도|들|이|가|은|는|을|를|에|로|와|과|도|만|랑|하고|까지|부터|마저|께|어서|아서|면서|으니|니까|네요|어요|아요|예요|이에요)$/, "");
    // 절단 결과가 1글자면 원형 명사가 깨진 것(예: "사과"→"사") — 원형 유지해 keyword_score 탈락 방지.
    return s.length >= 2 ? s : w;
  };
  const rawNouns = queryText.match(/[가-힣]{2,5}/g) || [];
  const nouns = Array.from(new Set(rawNouns.map(stripParticle).filter(w => w.length >= 2 && !STOP.has(w))));
  // 매칭 명사 개수 합산 → keyword_score (다중 명사 일치 우선)
  // 방어적 파라미터화 — 명사를 SQL에 직접 끼우지 않고 바인드($4+).
  //   (입력이 [가-힣]{2,5}로 제한돼 현재도 인젝션 불가하나, 정규식 변경 시 대비한 defense-in-depth)
  const nounParams = nouns.slice(0, 5);
  const keywordScore = nounParams.length > 0
    ? nounParams.map((_, i) => `(CASE WHEN me.content_text ILIKE '%' || $${i + 4} || '%' THEN 1 ELSE 0 END)`).join(" + ")
    : "0";

  // pgvector cosine + 키워드 가중 결합:
  //   - keyword_score = 매칭된 query 명사 개수 (다중 매칭이 우선)
  //   - dedup으로 중복 content_text 제거
  //   - ORDER BY: keyword_score DESC (매칭 명사 많은 것), embedding <=> query ASC (의미 가까운 것)
  const rows = await prisma.$queryRawUnsafe<{ content_text: string; created_at: Date }[]>(
    `WITH base AS (
       SELECT me.content_text, me.created_at, me.embedding,
              (${keywordScore}) AS keyword_score
       FROM message_embeddings me
       LEFT JOIN "Message" m ON m.id = me.message_id
       WHERE me.user_id = $1
         AND (m."isAnomaly" IS DISTINCT FROM true)
         AND (m.role IS NULL OR m.role = 'user')
     ),
     dedup AS (
       SELECT DISTINCT ON (content_text) content_text, created_at, embedding, keyword_score
       FROM base
       ORDER BY content_text, keyword_score DESC, created_at DESC
     )
     SELECT content_text, created_at
     FROM dedup
     ORDER BY keyword_score DESC, embedding <=> $2::vector
     LIMIT $3`,
    userId,
    vectorStr,
    limit,
    ...nounParams,
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
