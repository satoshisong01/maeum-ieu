"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useRef } from "react";

/**
 * 마음이음 RN 앱(WebView) ↔ 웹 브릿지.
 *
 * RN WebView 안에서 실행될 때만 동작(window.ReactNativeWebView 존재 시).
 * - 로그인/세션 활성 → { type:"LOGIN_SUCCESS", userId } 전송 → 앱이 maeum_<userId> 토픽 구독
 * - 로그아웃 → { type:"LOGOUT" } 전송 → 앱이 토픽 구독 해제
 * - 앱이 보낸 구매 토큰(PURCHASE_TOKEN)을 서버에 검증 요청 → 완료 시 앱에 마감 신호
 *
 * 왜 구매 검증이 여기 있나: 네이티브 계층에는 로그인 쿠키가 없어 서버가 결제자를 알 수 없다.
 *   그래서 **세션을 가진 웹**이 검증을 호출해야 한다. 그리고 앱은 로그인 직후
 *   미완료 구매를 재전송하므로(검증 전 앱 종료 복구), 어느 화면에 있어도 처리되어야 한다
 *   — /subscribe 화면에만 두면 복구가 유실된다.
 *
 * 일반 브라우저에서는 ReactNativeWebView가 없으므로 noop.
 */
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

/** 구독 상태가 바뀌었음을 같은 페이지의 다른 컴포넌트에 알리는 이벤트 */
export const BILLING_UPDATED_EVENT = "maeum:billing-updated";

export function RnBridge() {
  const { data: session, status } = useSession();
  const lastSentRef = useRef<string | null>(null);
  /** 같은 토큰을 중복 검증하지 않게 — 앱이 복구로 여러 번 보낼 수 있다 */
  const verifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const rn = typeof window !== "undefined" ? window.ReactNativeWebView : undefined;
    if (!rn || status === "loading") return;

    const userId = session?.user?.id;
    if (status === "authenticated" && userId) {
      if (lastSentRef.current === userId) return;
      lastSentRef.current = userId;
      rn.postMessage(JSON.stringify({ type: "LOGIN_SUCCESS", userId }));
    } else if (status === "unauthenticated") {
      if (lastSentRef.current === "__logout__") return;
      lastSentRef.current = "__logout__";
      rn.postMessage(JSON.stringify({ type: "LOGOUT" }));
    }
  }, [status, session?.user?.id]);

  const verify = useCallback(async (purchaseToken: string, productId?: string) => {
    if (verifiedRef.current.has(purchaseToken)) return;
    verifiedRef.current.add(purchaseToken);
    try {
      const r = await fetch("/api/billing/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseToken, productId }),
      });
      if (!r.ok) {
        // 마감 신호를 보내지 않는다 — 미완료로 남겨 다음 실행에서 다시 검증되게.
        verifiedRef.current.delete(purchaseToken);
        const j = await r.json().catch(() => null) as { error?: string } | null;
        window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, {
          detail: { ok: false, error: j?.error || "구매를 확인하지 못했습니다." },
        }));
        return;
      }
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "PURCHASE_VERIFIED", purchaseToken }));
      window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, { detail: { ok: true } }));
    } catch {
      verifiedRef.current.delete(purchaseToken);
      window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, {
        detail: { ok: false, error: "구매 확인 중 오류가 발생했습니다." },
      }));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.ReactNativeWebView) return;
    const onMsg = (e: MessageEvent) => {
      const d = typeof e.data === "string" ? e.data : "";
      if (!d.includes("PURCHASE_TOKEN")) return;
      try {
        const msg = JSON.parse(d) as { type?: string; purchaseToken?: string; productId?: string };
        if (msg.type === "PURCHASE_TOKEN" && msg.purchaseToken) {
          void verify(msg.purchaseToken, msg.productId);
        }
      } catch { /* 다른 메시지 */ }
    };
    window.addEventListener("message", onMsg);
    document.addEventListener("message", onMsg as EventListener); // 안드로이드 WebView
    return () => {
      window.removeEventListener("message", onMsg);
      document.removeEventListener("message", onMsg as EventListener);
    };
  }, [verify]);

  return null;
}
