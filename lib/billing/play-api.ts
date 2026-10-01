/**
 * Google Play Developer API 클라이언트 — 구독 구매 검증·승인.
 *
 * 의존성 없이 구현한 이유: 필요한 건 서비스 계정 JWT로 액세스 토큰을 받아 REST 두 개를
 *   호출하는 것뿐이다. googleapis 패키지는 수십 MB이고, google-auth-library는 이 프로젝트에
 *   직접 의존성이 아니라 @google-cloud/* 의 전이 의존성이라 버전이 조용히 바뀔 수 있다.
 *   node:crypto로 RS256 서명하고 fetch로 호출한다(약 60줄).
 *
 * 신뢰 모델: **클라이언트가 보낸 구독 상태는 신뢰하지 않는다.** purchaseToken만 받아
 *   Google에 직접 물어본 결과를 기록한다. 검증할 수 없으면 권리를 주지 않는다
 *   (다른 실패는 '열린 방향'으로 처리하지만, 돈이 걸린 판정은 닫힌 방향이 맞다).
 *
 * ⚠ 승인(acknowledge) 3일 규칙: 구매를 3일 안에 승인하지 않으면 Google이 자동 환불하고
 *   구독을 취소한다. 클라이언트가 결제 직후 꺼지면 승인이 유실되므로 **서버에서 승인**한다.
 *
 * 필요한 환경변수
 *   PLAY_PACKAGE_NAME          예: com.maeumapp
 *   PLAY_SERVICE_ACCOUNT_JSON  서비스 계정 키 JSON(원문 또는 base64). Play Console에서
 *                              재무 데이터 조회 권한을 부여한 계정이어야 한다.
 */
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";

export interface PlaySubscription {
  /** Play의 구독 상태 원문 — SUBSCRIPTION_STATE_* */
  state: string;
  /** 혜택 만료 시각(가장 늦은 lineItem 기준) */
  expiresAt: Date | null;
  productId: string | null;
  /** 승인 대기 상태인가 — true면 3일 안에 승인해야 환불되지 않는다 */
  needsAcknowledge: boolean;
  /** 사용자가 자동 갱신을 끈 상태(해지 예약) */
  autoRenewing: boolean;
  /** Play가 알려준 연결 계정 식별자 — 구매 시 넣어둔 obfuscatedExternalAccountId */
  externalAccountId: string | null;
}

interface ServiceAccount { client_email: string; private_key: string }

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    // base64로 넣는 경우가 많다(개행 포함 JSON을 환경변수에 넣기 어려움)
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf-8");
    const sa = JSON.parse(json) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    return { ...sa, private_key: sa.private_key.replace(/\\n/g, "\n") };
  } catch (e) {
    console.error("[play-api] PLAY_SERVICE_ACCOUNT_JSON 파싱 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Play Developer API를 쓸 수 있는 설정인가 */
export function isPlayConfigured(): boolean {
  return !!(process.env.PLAY_PACKAGE_NAME?.trim() && loadServiceAccount());
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// 액세스 토큰 캐시 — 1시간 유효. 매 검증마다 토큰을 새로 받을 이유가 없다.
let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) return cachedToken.token;

  const sa = loadServiceAccount();
  if (!sa) throw new Error("PLAY_SERVICE_ACCOUNT_JSON 미설정");

  const iat = Math.floor(Date.now() / 1000);
  const claims = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`액세스 토큰 발급 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

/** 구독 구매 조회(subscriptionsv2) — Google이 말하는 현재 상태가 유일한 진실이다. */
export async function getSubscription(purchaseToken: string): Promise<PlaySubscription> {
  const pkg = process.env.PLAY_PACKAGE_NAME?.trim();
  if (!pkg) throw new Error("PLAY_PACKAGE_NAME 미설정");
  const token = await getAccessToken();

  const url = `${API}/applications/${encodeURIComponent(pkg)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 토큰이 가짜거나 다른 앱의 것이면 404/400 — 권리를 주지 않는다
    throw new Error(`구독 조회 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const d = await res.json() as {
    subscriptionState?: string;
    acknowledgementState?: string;
    externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
    lineItems?: { productId?: string; expiryTime?: string; autoRenewingPlan?: { autoRenewEnabled?: boolean } }[];
  };

  // 여러 lineItem(플랜 변경 중 등)이면 가장 늦은 만료 시각을 혜택 종료로 본다
  let expiresAt: Date | null = null;
  let productId: string | null = null;
  let autoRenewing = false;
  for (const li of d.lineItems ?? []) {
    if (li.expiryTime) {
      const t = new Date(li.expiryTime);
      if (!Number.isNaN(t.getTime()) && (!expiresAt || t > expiresAt)) { expiresAt = t; productId = li.productId ?? productId; }
    }
    if (li.autoRenewingPlan?.autoRenewEnabled) autoRenewing = true;
    productId = productId ?? li.productId ?? null;
  }

  return {
    state: d.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED",
    expiresAt,
    productId,
    needsAcknowledge: d.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING",
    autoRenewing,
    externalAccountId: d.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
  };
}

/**
 * 구매 승인 — 3일 안에 하지 않으면 자동 환불된다.
 * 이미 승인된 구매에 다시 호출하면 Google이 에러를 주는데, 무해하므로 경고만 남긴다.
 */
export async function acknowledgeSubscription(productId: string, purchaseToken: string): Promise<boolean> {
  const pkg = process.env.PLAY_PACKAGE_NAME?.trim();
  if (!pkg) return false;
  try {
    const token = await getAccessToken();
    const url = `${API}/applications/${encodeURIComponent(pkg)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[play-api] 승인 실패 ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[play-api] 승인 호출 오류:", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Play 구독 상태 → 우리 status 값.
 * 혜택 유지 여부는 lib/billing/plans.ts의 ENTITLED_STATUSES가 결정한다.
 */
export function mapState(state: string, autoRenewing: boolean): string {
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":        return autoRenewing ? "active" : "canceled"; // 해지 예약도 만료일까지 혜택 유지
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD": return "grace";
    case "SUBSCRIPTION_STATE_CANCELED":      return "canceled";
    case "SUBSCRIPTION_STATE_ON_HOLD":       return "on_hold";
    case "SUBSCRIPTION_STATE_PAUSED":        return "paused";
    case "SUBSCRIPTION_STATE_EXPIRED":       return "expired";
    case "SUBSCRIPTION_STATE_PENDING":       return "pending"; // 결제 보류(지연 결제) — 혜택 없음
    default:                                  return "expired";
  }
}
