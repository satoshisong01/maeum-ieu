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
import { sendEmergencyPush } from "@/lib/notify/push-fcm";
import { sendEmergencyEmail } from "@/lib/notify/email";
import { decryptPII } from "@/lib/crypto";
import dns from "node:dns/promises";

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

/** IPv4가 사설·예약·메타데이터 대역인지 */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 비정상 → 차단
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;            // link-local + 클라우드 메타데이터(169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16/12
  if (a === 192 && b === 168) return true;            // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  return false;
}

/**
 * SSRF 방어 — 보호자 웹훅 URL이 내부/사설/메타데이터로 향하지 않는지 검증.
 * 호스트네임을 실제 IP로 해석해 사설 대역이면 차단(DNS rebinding 방어). 해석 실패 시 차단.
 */
async function isSafeWebhookUrl(rawUrl: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return false;
    for (const { address, family } of addrs) {
      if (family === 4 && isPrivateIPv4(address)) return false;
      const a = address.toLowerCase();
      if (family === 6 && (a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80"))) return false;
      if (family === 6 && a.startsWith("::ffff:") && isPrivateIPv4(a.replace("::ffff:", ""))) return false;
    }
  } catch { return false; }
  return true;
}

async function sendWebhook(url: string, body: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!(await isSafeWebhookUrl(url))) {
    console.warn("[emergency-notify] 안전하지 않은 웹훅 URL 차단(SSRF 방어)");
    return { ok: false, error: "unsafe webhook url blocked" };
  }
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

  // 3) Webhook 발송 (보호자가 URL을 등록한 경우)
  if (user.guardianWebhookUrl) {
    const r = await sendWebhook(user.guardianWebhookUrl, buildWebhookBody(payload));
    if (r.ok) channels.push("webhook");
    else console.warn("[emergency-notify] webhook failed:", r);
  }

  // 4) FCM 푸시 — 환자와 연결된 보호자(전문가) 계정의 앱 토픽으로 발송.
  //    보호자가 마음이음 앱에 로그인하면 maeum_<보호자id> 토픽을 구독함.
  const links = await prisma.expertPatient.findMany({
    where: { patientUserId: payload.userId, status: "active" },
    select: { expertUserId: true },
  });
  const guardianIds = links.map((l) => l.expertUserId);
  if (guardianIds.length > 0) {
    const push = await sendEmergencyPush(guardianIds, {
      title: payload.level === 3 ? "🚨 즉시 응급 신호" : "⚠️ 주의 신호",
      body:
        payload.level === 3
          ? `${payload.userName}님 — ${payload.category}. 지금 바로 연락하시거나 119에 신고해주세요.`
          : `${payload.userName}님 — ${payload.category}. 안부를 확인해주세요.`,
      level: payload.level,
      category: payload.category,
    });
    if (push.sent > 0) channels.push("fcm");
    else if (push.failed > 0) console.warn("[emergency-notify] fcm failed:", push);
  }

  // 5) 이메일 — 보호자 이메일(암호화 저장)로 발송. RESEND_API_KEY 없으면 skip.
  if (user.guardianEmail) {
    const email = decryptPII(user.guardianEmail);
    if (email) {
      const ok = await sendEmergencyEmail(email, {
        userName: payload.userName,
        level: payload.level,
        category: payload.category,
        createdAt: payload.createdAt,
      });
      if (ok) channels.push("email");
    }
  }

  // 6) 발송 시각 마킹 (어느 채널이든 1건 이상 성공 시)
  if (channels.length > 0) {
    await prisma.message.update({
      where: { id: payload.messageId },
      data: { notifiedAt: new Date() },
    });
  }

  return { sent: channels.length > 0, channels };
}
