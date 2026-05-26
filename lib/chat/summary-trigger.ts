/**
 * 자동 요약 트리거 — 응답 후 백그라운드로 호출.
 *
 * 알고리즘:
 *   1. 현재 conversation 메시지 총 개수 확인
 *   2. 마지막 weekly summary 이후 새 메시지가 50건+ 누적되었으면 새 weekly 생성
 *   3. unparent weekly 4개 모이면 monthly rollup
 *   4. unparent monthly 12개 모이면 yearly rollup
 *
 * 실패해도 사용자 응답에 영향 없음. errors swallowed.
 */

import { prisma } from "@/lib/prisma";
import { summarizeMessages, rollupSummaries } from "./summarizer";

const WEEKLY_TRIGGER_THRESHOLD = 50;  // 마지막 요약 이후 새 메시지 50건+

interface MsgRow {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

export async function maybeTriggerSummaryRollup(params: {
  userId: string;
  conversationId: string;
}): Promise<void> {
  const { userId, conversationId } = params;
  try {
    // 마지막 weekly 요약의 period_end 조회
    const last = await prisma.$queryRawUnsafe<{ periodEnd: Date }[]>(
      `SELECT period_end AS "periodEnd"
       FROM conversation_summary
       WHERE user_id = $1 AND conversation_id = $2 AND level = 'weekly'
       ORDER BY period_end DESC LIMIT 1`,
      userId, conversationId,
    );
    const cutoff = last[0]?.periodEnd ?? new Date(0);

    // 마지막 요약 이후 새 메시지 조회
    const msgs = await prisma.$queryRawUnsafe<MsgRow[]>(
      `SELECT id, role, content, "createdAt"
       FROM "Message"
       WHERE "conversationId" = $1 AND "createdAt" > $2::timestamptz
       ORDER BY "createdAt" ASC`,
      conversationId, cutoff,
    );
    if (msgs.length < WEEKLY_TRIGGER_THRESHOLD) return;

    // 새 weekly 생성
    await summarizeMessages({ userId, conversationId, messages: msgs, level: "weekly" });

    // rollup 체인: weekly 4개 → monthly, monthly 12개 → yearly
    for (let i = 0; i < 5; i++) {
      const r = await rollupSummaries({ userId, conversationId, childLevel: "weekly" });
      if (!r) break;
    }
    for (let i = 0; i < 3; i++) {
      const r = await rollupSummaries({ userId, conversationId, childLevel: "monthly" });
      if (!r) break;
    }
  } catch (e) {
    console.warn("[summary-trigger] error:", (e as Error).message);
  }
}
