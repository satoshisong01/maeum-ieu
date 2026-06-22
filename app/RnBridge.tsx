"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";

/**
 * 마음이음 RN 앱(WebView) ↔ 웹 브릿지.
 *
 * RN WebView 안에서 실행될 때만 동작(window.ReactNativeWebView 존재 시).
 * - 로그인/세션 활성 → { type:"LOGIN_SUCCESS", userId } 전송 → 앱이 maeum_<userId> 토픽 구독
 * - 로그아웃 → { type:"LOGOUT" } 전송 → 앱이 토픽 구독 해제
 *
 * 일반 브라우저에서는 ReactNativeWebView가 없으므로 noop.
 */
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

export function RnBridge() {
  const { data: session, status } = useSession();
  const lastSentRef = useRef<string | null>(null);

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

  return null;
}
