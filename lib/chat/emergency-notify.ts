/**
 * 응급 신호 발생 시 보호자에게 알림 전송.
 *
 * Phase 2: Webhook(Discord/Slack/IFTTT/Zapier 등 호환) POST + 옵션 이메일.
 *   SMS/카카오 알림톡은 외부 유료 서비스 연동 필요하므로 추후.
 *
 * 보호자가 Webhook URL을 등록하면 그 endpoint로 JSON POST.
 * 등록 없으면 콘솔 로그만 남기고 noop.
 *
 * 중복 방지:
 * - 같은 사용자의 같은 카테고리는 1시간 내 1회만 발송.
 * - notifiedAt이 이미 찍힌 메시지는 재발송 안 함.
 */

import { prisma } from "@/lib/prisma";

export interface NotifyPayload {
  userId: string;
  userName: string;
  messageId: string;
  level: 2 | 3;
  category: string;
  content: string;          // 사용자 발화 원문 (요약본)
  aiReply: string;          // AI 응답 (요약본)
  createdAt: Date;
}

export interface NotifyResult {
  sent: boolean;
  channels: string[];       // ["webhook", "email"]
  reason?: string;          // 미발송 사유
}

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1시간

function levelLabel(level: number): string {
  return level === 3 ? "🚨 즉시 응급" : level === 2 ? "⚠️ 주의 필요" : "관찰";
}

function buildWebhookBody(payload: NotifyPayload): unknown {
  // Discord-compatible 형식 — Slack/IFTTT/n8n도 content 필드는 공통 처리.
  const lvl = levelLabel(payload.level);
  const title = payload.level === 3
    ? `[마음이음] 즉시 응급 신호 감지`
    : `[마음이음] 주의 신호 감지`;
  const body = [
    `${lvl}`,
    `사용자: ${payload.userName}`,
    `카테고리: ${payload.category}`,
    `사용자 발화: "${payload.content.slice(0, 200)}"`,
    `AI 응답: "${payload.aiReply.slice(0, 200)}"`,
    `시각: ${payload.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    payload.level === 3 ? `\n👉 지금 바로 ${payload.userName}님께 연락하시거나 119에 신고해주세요.` : `\n👉 시간 되실 때 ${payload.userName}님 안부 확인 부탁드립니다.`,
  ].join("\n");

  return {
    content: `**${title}**\n${body}`,                  // Discord/Slack content
    text: `${title}\n${body}`,                          // 일부 webhook 시스템용
    embeds: [{                                          // Discord embed
      title,
      description: body,
      color: payload.level === 3 ? 0xff0000 : 0xff9500,
      timestamp: payload.createdAt.toISOString(),
    }],
  };
}

async function sendWebhook(url: string, body: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 중복 발송 차단 — 같은 사용자 + 같은 카테고리 + 1시간 내 발송 이력이 있으면 skip.
 */
async function isDuplicate(userId: string, category: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  const recent = await prisma.message.findFirst({
    where: {
      conversation: { userId },
      emergencyLevel: { gte: 2 },
      notifiedAt: { gte: cutoff },
      emergencyEvidence: { startsWith: `${category}:` },
    },
    select: { id: true },
  });
  return recent !== null;
}

/**
 * 응급 알림 발송.
 * Returns 결과 + 발송한 채널 목록. 실패해도 throw 안 함 (LLM 응답에 영향 X).
 */
export async function notifyGuardian(payload: NotifyPayload): Promise<NotifyResult> {
  const channels: string[] = [];

  // 1) 중복 차단
  if (await isDuplicate(payload.userId, payload.category)) {
    return { sent: false, channels: [], reason: `dedup window (${DEDUP_WINDOW_MS / 60000}분 내 동일 카테고리 발송 이력)` };
  }

  // 2) 사용자 보호자 정보 조회
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { guardianWebhookUrl: true, guardianEmail: true, guardianName: true },
  });
  if (!user) return { sent: false, channels: [], reason: "user not found" };

  const hasWebhook = !!user.guardianWebhookUrl;
  if (!hasWebhook) {
    return { sent: false, channels: [], reason: "guardian webhook not configured" };
  }

  // 3) Webhook 발송
  if (hasWebhook && user.guardianWebhookUrl) {
    const body = buildWebhookBody(payload);
    const r = await sendWebhook(user.guardianWebhookUrl, body);
    if (r.ok) channels.push("webhook");
    else console.warn("[emergency-notify] webhook failed:", r);
  }

  // 4) 이메일 채널 — Phase 2.5 예정. nodemailer 설치 + SMTP_HOST 환경변수 설정 후 활성화.
  //   현재는 guardianEmail 저장만 지원하고 발송 로직은 webhook 측에서 처리 권장 (Zapier 등).

  // 5) 발송 시각 마킹
  if (channels.length > 0) {
    await prisma.message.update({
      where: { id: payload.messageId },
      data: { notifiedAt: new Date() },
    });
  }

  return { sent: channels.length > 0, channels };
}
