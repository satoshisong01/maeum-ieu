/**
 * 대화 요약 — 계층적 압축 (weekly → monthly → yearly).
 *
 * 구조:
 *   L1 raw messages       : Message 테이블 그대로
 *   L2 weekly summary     : 1주 단위 (월요일~일요일)
 *   L3 monthly summary    : 4개 weekly 합치기
 *   L4 yearly summary     : 12개 monthly 합치기
 *
 * prompt 주입: 최근 raw N턴 + 최근 weekly 2개 + 최근 monthly 1개 + 최근 yearly 1개
 *
 * 사용자 격리: 모든 쿼리 user_id 필터 강제.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";

const SUMMARY_MODEL = "gemini-2.5-flash";
export type SummaryLevel = "weekly" | "monthly" | "yearly";

const SUMMARY_PROMPT = `당신은 노인 인지 케어 시스템의 대화 요약가입니다. 아래 대화를 분석해 두 가지를 출력하세요.

[1. 자연어 요약 (200~400자)]
- 사용자(어르신)가 말한 핵심 내용만 추려서 자연스러운 한국어로 요약.
- 가족 관계·이름·일상 패턴·건강 상태·취미·고향·정서 변화 중심.
- AI 응답은 무시. 사용자 발화만 요약.

[2. 핵심 사실 JSON]
다음 키 중 명확한 정보가 있을 때만 추가. 추측·확장 금지.
{
  "family": [{"relation": "son|daughter|grandchild|spouse|sibling", "name": "이름", "note": "특징"}],
  "hometown": "고향",
  "residence": "현 거주지",
  "hobbies": ["취미"],
  "health": ["증상"],
  "favorites": ["좋아하는 음식"],
  "events": [{"when": "시점 묘사", "what": "사건"}]
}
사실이 명확히 없으면 빈 배열/null. 추측 금지.

**출력 형식 (반드시 이대로)**:
---SUMMARY---
[여기에 자연어 요약]
---FACTS---
[여기에 JSON]
---END---`;

const META_SUMMARY_PROMPT = `당신은 대화 요약본을 다시 압축하는 메타 요약가입니다.
아래는 사용자(어르신)의 시기별 대화 요약본입니다. 이들을 통합하여 더 긴 기간의 요약으로 압축하세요.

[1. 자연어 요약 (300~500자)]
- 사용자의 일관된 패턴(자주 등장하는 주제·감정·관심사) 중심
- 시기별 변화가 있으면 명시 (예: "초반에는 ~ 그러나 ~ 이후에는 ~")
- 가족 정보는 그대로 보존, 새로 등장한 정보 통합

[2. 핵심 사실 JSON]
하위 요약들의 facts를 통합. 중복 제거, 모순 시 더 최근 정보 우선.
{
  "family": [{"relation": "...", "name": "...", "note": "..."}],
  "hometown": "...",
  "residence": "...",
  "hobbies": [...],
  "health": [...],
  "favorites": [...],
  "events": [...]
}

**출력 형식**:
---SUMMARY---
[자연어]
---FACTS---
[JSON]
---END---`;

export interface SummaryRow {
  id: string;
  summary: string;
  keyFacts: string | null;
  periodStart: Date;
  periodEnd: Date;
  level: SummaryLevel;
  messageCount: number;
}

interface MsgRow {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

function parseLLMOutput(raw: string): { summary: string; keyFacts: string } {
  // FACTS 섹션이 잘렸을 수 있어 fallback 다단계
  let summary = "";
  const m1 = raw.match(/---SUMMARY---\s*([\s\S]*?)\s*---FACTS---/);
  if (m1) summary = m1[1].trim();
  else {
    // FACTS 마커 없으면 SUMMARY 이후 전체 (END 마커까지, 없으면 끝까지)
    const m2 = raw.match(/---SUMMARY---\s*([\s\S]*?)(?:---END---|$)/);
    if (m2) summary = m2[1].trim();
  }
  // FACTS 추출
  const factsMatch = raw.match(/---FACTS---\s*([\s\S]*?)(?:---END---|$)/);
  const factsRaw = (factsMatch ? factsMatch[1] : "").trim();
  let keyFacts = "{}";
  if (factsRaw) {
    try { JSON.parse(factsRaw); keyFacts = factsRaw; }
    catch { keyFacts = JSON.stringify({ raw: factsRaw.slice(0, 500) }); }
  }
  return { summary, keyFacts };
}

/** raw 메시지를 weekly 요약으로 압축. */
export async function summarizeMessages(params: {
  userId: string;
  conversationId: string;
  messages: MsgRow[];
  level?: SummaryLevel;
}): Promise<SummaryRow | null> {
  const { userId, conversationId, messages, level = "weekly" } = params;
  if (messages.length === 0) return null;

  const periodStart = messages[0].createdAt;
  const periodEnd = messages[messages.length - 1].createdAt;

  // idempotent: 같은 사용자·대화·기간·레벨 요약 있으면 skip
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM conversation_summary
     WHERE user_id = $1 AND conversation_id = $2 AND level = $3
       AND period_start = $4::timestamptz AND period_end = $5::timestamptz`,
    userId, conversationId, level, periodStart, periodEnd,
  );
  if (existing.length > 0) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.warn("[summarizer] no GEMINI_API_KEY"); return null; }

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: SUMMARY_MODEL,
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });

  const transcript = messages.map((m) => {
    const t = m.role === "user" ? "사용자" : "AI";
    return `[${t}] ${m.content.replace(/\s+/g, " ").slice(0, 300)}`;
  }).join("\n");

  try {
    const res = await model.generateContent(`${SUMMARY_PROMPT}\n\n[대화]\n${transcript}`);
    const raw = res.response.text().trim();
    const { summary, keyFacts } = parseLLMOutput(raw);
    if (!summary || summary.length < 20) {
      console.warn("[summarizer] empty summary, raw preview:", raw.slice(0, 200));
      return null;
    }
    const id = `cs_${userId.slice(0, 8)}_${level}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO conversation_summary (id, user_id, conversation_id, period_start, period_end, summary, key_facts, message_count, level)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9)`,
      id, userId, conversationId, periodStart, periodEnd, summary, keyFacts, messages.length, level,
    );
    console.log("[summarizer] saved", JSON.stringify({
      userId: userId.slice(0, 8), level, msgs: messages.length, summaryLen: summary.length,
    }));
    return { id, summary, keyFacts, periodStart, periodEnd, level, messageCount: messages.length };
  } catch (e) {
    console.warn("[summarizer] error:", (e as Error).message);
    return null;
  }
}

/** 하위 레벨 요약 N개를 상위 레벨로 압축 (weekly 4개 → monthly 1개). */
export async function rollupSummaries(params: {
  userId: string;
  conversationId: string;
  childLevel: "weekly" | "monthly";
}): Promise<SummaryRow | null> {
  const { userId, conversationId, childLevel } = params;
  const parentLevel = childLevel === "weekly" ? "monthly" : "yearly";
  const minCount = childLevel === "weekly" ? 4 : 12;

  // 아직 parent로 압축되지 않은 active child 요약들 조회
  const children = await prisma.$queryRawUnsafe<SummaryRow[]>(
    `SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", message_count AS "messageCount", level
     FROM conversation_summary
     WHERE user_id = $1 AND conversation_id = $2 AND level = $3 AND is_active = true AND parent_id IS NULL
     ORDER BY period_start ASC`,
    userId, conversationId, childLevel,
  );
  if (children.length < minCount) return null;

  const targets = children.slice(0, minCount);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: SUMMARY_MODEL,
    generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
  });

  const transcript = targets.map((s, i) => {
    return `[#${i+1} ${s.periodStart.toISOString().slice(0,10)} ~ ${s.periodEnd.toISOString().slice(0,10)}]\n${s.summary}`;
  }).join("\n\n");

  try {
    const res = await model.generateContent(`${META_SUMMARY_PROMPT}\n\n[하위 요약들]\n${transcript}`);
    const { summary, keyFacts } = parseLLMOutput(res.response.text().trim());
    if (!summary || summary.length < 30) return null;

    const id = `cs_${userId.slice(0, 8)}_${parentLevel}_${Date.now()}`;
    const periodStart = targets[0].periodStart;
    const periodEnd = targets[targets.length - 1].periodEnd;
    const totalMsgs = targets.reduce((a, b) => a + b.messageCount, 0);

    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `INSERT INTO conversation_summary (id, user_id, conversation_id, period_start, period_end, summary, key_facts, message_count, level)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9)`,
        id, userId, conversationId, periodStart, periodEnd, summary, keyFacts, totalMsgs, parentLevel,
      ),
      // 하위 요약은 비활성화(prompt에서 제외) + parent 링크
      prisma.$executeRawUnsafe(
        `UPDATE conversation_summary SET parent_id = $1, is_active = false WHERE id = ANY($2::text[])`,
        id, targets.map((t) => t.id),
      ),
    ]);

    console.log("[summarizer] rollup", JSON.stringify({
      userId: userId.slice(0, 8), parentLevel, childCount: targets.length, totalMsgs,
    }));
    return { id, summary, keyFacts, periodStart, periodEnd, level: parentLevel as SummaryLevel, messageCount: totalMsgs };
  } catch (e) {
    console.warn("[summarizer] rollup error:", (e as Error).message);
    return null;
  }
}

/**
 * 사용자 prompt에 주입할 요약본 조회 — 계층별 최근 N개.
 * 권장: weekly 2개 (최근 2주) + monthly 1개 (지난 달) + yearly 1개 (이전 해)
 */
export async function getRecentSummaries(userId: string, limits = { weekly: 2, monthly: 1, yearly: 1 }): Promise<SummaryRow[]> {
  const rows = await prisma.$queryRawUnsafe<SummaryRow[]>(
    `(SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", level, message_count AS "messageCount"
      FROM conversation_summary
      WHERE user_id = $1 AND level = 'weekly' AND is_active = true
      ORDER BY period_end DESC LIMIT $2)
     UNION ALL
     (SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", level, message_count AS "messageCount"
      FROM conversation_summary
      WHERE user_id = $1 AND level = 'monthly' AND is_active = true
      ORDER BY period_end DESC LIMIT $3)
     UNION ALL
     (SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", level, message_count AS "messageCount"
      FROM conversation_summary
      WHERE user_id = $1 AND level = 'yearly' AND is_active = true
      ORDER BY period_end DESC LIMIT $4)`,
    userId, limits.weekly, limits.monthly, limits.yearly,
  );
  return rows;
}

export function renderSummariesForPrompt(summaries: SummaryRow[]): string {
  if (summaries.length === 0) return "";
  const now = Date.now();
  const LEVEL_KO: Record<SummaryLevel, string> = { weekly: "주간", monthly: "월간", yearly: "연간" };
  // 시점이 오래된 것부터 정렬
  const sorted = summaries.slice().sort((a, b) => new Date(a.periodEnd).getTime() - new Date(b.periodEnd).getTime());
  const lines = sorted.map((s) => {
    const days = Math.floor((now - new Date(s.periodEnd).getTime()) / (24 * 60 * 60 * 1000));
    const tag = days <= 7 ? "최근" : days <= 30 ? `${Math.floor(days/7)}주 전` : days <= 365 ? `${Math.floor(days/30)}달 전` : `${Math.floor(days/365)}년 전`;
    return `[${LEVEL_KO[s.level]} 요약 / ${tag}] ${s.summary}`;
  });
  return `[과거 대화 요약 — 사실 확인 보조]\n${lines.join("\n\n")}`;
}
