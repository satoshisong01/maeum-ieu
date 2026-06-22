/**
 * FCM(Firebase Cloud Messaging) 푸시 발송 — 보호자 앱(RN WebView)으로 위급 알림.
 *
 * 토픽 방식: 보호자가 앱 로그인 시 자기 userId 토픽(maeum_<id>)을 구독.
 *   서버는 환자 응급 발생 시 연결된 보호자들의 토픽으로 data-only 메시지를 발송.
 *   → 기기 토큰을 DB에 저장/관리할 필요가 없음.
 *
 * data-only(notification 필드 없음) + priority high:
 *   앱이 포그라운드/백그라운드에서 표시를 직접 제어(소리·진동·모달·notifee 채널).
 *
 * 자격증명(FCM_SERVICE_ACCOUNT env)이 없으면 graceful skip — 로컬/미설정 환경에서 무력화.
 */

import { initializeApp, getApps, getApp, cert, type App, type ServiceAccount } from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";

let cachedApp: App | null | undefined;

/**
 * 서비스 계정 JSON 문자열 로드.
 * FCM_SERVICE_ACCOUNT_B64(base64, 권장 — 줄바꿈·따옴표 문제 없음) 우선,
 * 없으면 FCM_SERVICE_ACCOUNT(raw JSON, 반드시 한 줄).
 */
function loadServiceAccountJson(): string | null {
  const b64 = process.env.FCM_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return process.env.FCM_SERVICE_ACCOUNT ?? null;
}

/** 서비스 계정 env로 firebase-admin 1회 초기화. 미설정/파싱 실패 시 null(=비활성). */
function getFcmApp(): App | null {
  if (cachedApp !== undefined) return cachedApp;
  const json = loadServiceAccountJson();
  if (!json) {
    cachedApp = null;
    return null;
  }
  try {
    const serviceAccount = JSON.parse(json) as ServiceAccount;
    cachedApp = getApps().length ? getApp() : initializeApp({ credential: cert(serviceAccount) });
  } catch (e) {
    console.warn("[push-fcm] 서비스 계정 파싱 실패 — 푸시 비활성:", (e as Error).message);
    cachedApp = null;
  }
  return cachedApp;
}

const TOPIC_PREFIX = "maeum_";

/** userId → FCM 토픽명. FCM 허용 문자([a-zA-Z0-9-_.~%])만 남김(cuid는 그대로 통과). */
export function userTopic(userId: string): string {
  return TOPIC_PREFIX + userId.replace(/[^a-zA-Z0-9_.~%-]/g, "_");
}

export interface PushPayload {
  title: string;
  body: string;
  level: 2 | 3;
  category: string;
  sound?: string; // 앱 번들 사운드 키 (기본 "alarm")
}

export interface PushResult {
  sent: number;
  failed: number;
  skipped?: string; // 발송 안 한 사유 (미설정 등)
}

/** FCM 사용 가능 여부(자격증명 설정됨) — 호출부에서 채널 표기에 활용. */
export function isFcmConfigured(): boolean {
  return getFcmApp() !== null;
}

/**
 * 보호자 userId 목록 → 각자의 토픽으로 위급 알림 발송.
 * 실패해도 throw 안 함(LLM 응답 흐름에 영향 X).
 */
export async function sendEmergencyPush(userIds: string[], payload: PushPayload): Promise<PushResult> {
  const app = getFcmApp();
  if (!app) return { sent: 0, failed: 0, skipped: "FCM not configured" };
  if (userIds.length === 0) return { sent: 0, failed: 0, skipped: "no targets" };

  const messages: Message[] = userIds.map((uid) => ({
    topic: userTopic(uid),
    // notification 페이로드 — 앱이 종료/백그라운드여도 OS가 직접 알림 표시(앱 코드 실행 불필요).
    notification: { title: payload.title, body: payload.body },
    data: {
      title: payload.title,
      body: payload.body,
      level: String(payload.level),
      category: payload.category,
      sound: payload.sound ?? "alarm",
      notificationId: `${Date.now()}_${uid}`, // 앱 측 중복 표시 차단용 고유 ID
    },
    android: {
      priority: "high",
      notification: {
        channelId: "maeum-emergency", // 앱이 만든 HIGH 채널(소리·진동·bypassDnd). 없으면 기본 채널로 표시
        sound: payload.sound ?? "alarm",
        priority: "max",
      },
    },
  }));

  try {
    const res = await getMessaging(app).sendEach(messages);
    if (res.failureCount > 0) {
      const firstErr = res.responses.find((r) => !r.success)?.error?.message;
      console.warn(`[push-fcm] 일부 실패 ${res.failureCount}/${messages.length}:`, firstErr);
    }
    return { sent: res.successCount, failed: res.failureCount };
  } catch (e) {
    console.warn("[push-fcm] 발송 실패:", (e as Error).message);
    return { sent: 0, failed: userIds.length };
  }
}
