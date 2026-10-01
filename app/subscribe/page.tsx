"use client";

/**
 * 구독 안내·구매 — 앱에서는 Play 결제 시트를, 웹에서는 안내만 보여준다.
 *
 * 왜 웹에서 결제하지 않나: 안드로이드 앱에서 판매하는 디지털 구독은 Google Play 결제를
 *   써야 한다(정책). 그래서 결제는 RN 앱의 네이티브 계층에서만 일어나고, 웹은 상태를
 *   보여주고 앱으로 유도한다. 브라우저에서 결제 버튼을 보여주면 안내만 하고 끝낸다.
 *
 * 흐름: [구독하기] → RN에 PURCHASE_SUBSCRIPTION 전송 → 앱이 Play 시트 → 구매 성공 시
 *   앱이 /api/billing/verify 호출(또는 웹에 토큰 전달) → 이 화면이 상태를 다시 읽어 반영.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BILLING_UPDATED_EVENT } from "../RnBridge";
import { MIN_BILLING_APP_VERSION, isOlderVersion } from "@/lib/app-version";

interface Status {
  tier: "free" | "pro";
  expiresAt: string | null;
  source: "none" | "purchaser" | "beneficiary";
  guardianFeatures: boolean;
  beneficiaryName: string | null;
  usage: { used: number; limit: number; remaining: number } | null;
  productIds: string[];
  enforced: boolean;
}

export default function SubscribePage() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inApp = typeof window !== "undefined" && !!window.ReactNativeWebView;
  // 구버전 앱은 결제 메시지를 처리하지 못해 버튼이 멈춘 것처럼 보인다 — 업데이트를 안내한다.
  const appVersion = typeof window !== "undefined"
    ? (window as unknown as { MAEUM_APP_VERSION?: string }).MAEUM_APP_VERSION : undefined;
  const appTooOld = inApp && (!appVersion || isOlderVersion(appVersion, MIN_BILLING_APP_VERSION));

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/billing/status");
      if (r.status === 401) { setErr("로그인이 필요합니다."); return; }
      if (!r.ok) { setErr("상태를 불러오지 못했습니다."); return; }
      setSt(await r.json());
    } catch {
      setErr("상태를 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => { (async () => { await load(); })(); }, [load]);

  /**
   * 결제 결과 반영.
   *   구매 토큰 검증은 앱 전역 브릿지(RnBridge)가 처리한다 — 로그인 직후 '미완료 구매 복구'가
   *   어느 화면에서도 동작해야 하기 때문. 이 화면은 결과만 받아 표시한다.
   */
  useEffect(() => {
    const onBilling = (e: Event) => {
      const detail = (e as CustomEvent<{ ok?: boolean; error?: string }>).detail;
      setBusy(false);
      if (detail?.ok) { setErr(""); void load(); }
      else if (detail?.error) setErr(`${detail.error} 앱을 다시 열면 자동으로 다시 시도합니다.`);
    };
    const onMsg = (e: MessageEvent) => {
      const d = typeof e.data === "string" ? e.data : "";
      if (!d.includes("PURCHASE_")) return;
      try {
        const msg = JSON.parse(d) as { type?: string; error?: string };
        if (msg.type === "PURCHASE_CANCELED") setBusy(false);
        if (msg.type === "PURCHASE_FAILED") { setBusy(false); setErr(msg.error || "결제가 완료되지 않았습니다."); }
      } catch { /* 다른 메시지 */ }
    };
    window.addEventListener(BILLING_UPDATED_EVENT, onBilling);
    window.addEventListener("message", onMsg);
    document.addEventListener("message", onMsg as EventListener); // 안드로이드 WebView
    return () => {
      window.removeEventListener(BILLING_UPDATED_EVENT, onBilling);
      window.removeEventListener("message", onMsg);
      document.removeEventListener("message", onMsg as EventListener);
    };
  }, [load]);

  const purchase = () => {
    const productId = st?.productIds?.[0];
    if (!productId) { setErr("구독 상품이 아직 준비되지 않았습니다."); return; }
    setErr(""); setBusy(true);
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "PURCHASE_SUBSCRIPTION", productId }));
    // 앱이 응답하지 않는 경우(구버전 앱)에도 버튼이 영구 비활성되지 않게
    setTimeout(() => setBusy(false), 60_000);
  };

  const isPro = st?.tier === "pro";

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-[#eef2f7] px-5 py-6 dark:from-[#0b1220] dark:to-[#0b0d10]">
      <div className="mx-auto max-w-md">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-2xl font-extrabold text-zinc-800 dark:text-zinc-100">구독</h1>
          <Link href="/" className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-600 shadow-sm dark:bg-zinc-900 dark:text-zinc-300">← 돌아가기</Link>
        </div>

        {err && <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{err}</p>}

        {/* 현재 상태 */}
        <section className={`mb-4 rounded-2xl border p-5 ${isPro ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-900/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}>
          <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">현재 이용 중</h2>
          <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {st === null ? "확인 중…" : isPro ? "구독 중" : "무료"}
          </p>
          {isPro && st?.expiresAt && (
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              {new Date(st.expiresAt).toLocaleDateString("ko-KR")}까지 이용할 수 있어요.
            </p>
          )}
          {isPro && st?.beneficiaryName && (
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">혜택 적용 대상: <b>{st.beneficiaryName}</b></p>
          )}
          {st?.usage && (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              오늘 대화 {st.usage.used}회{st.usage.limit > 0 ? ` / ${st.usage.limit}회` : ""}
            </p>
          )}
        </section>

        {/* 혜택 */}
        <section className="mb-4 rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
          <h2 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">구독하면</h2>
          <ul className="mt-3 space-y-2 text-base text-zinc-700 dark:text-zinc-200">
            <li>💬 <b>하루 대화량이 늘어나요</b> — 어르신이 더 오래 이야기할 수 있어요.</li>
            <li>📋 <b>상태 요약·추세를 볼 수 있어요</b> — 보호자 화면의 등급·변화 추이와 복약 이행률.</li>
          </ul>
          <p className="mt-3 rounded-xl bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            🚨 위급 알림은 <b>구독과 무관하게 항상</b> 제공됩니다. 안전 기능에는 돈을 받지 않아요.
          </p>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            보호자가 결제하면 연결된 어르신 계정에 혜택이 적용됩니다.
          </p>
        </section>

        {/* 구매 */}
        {!isPro && (
          appTooOld ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
              구독 결제는 <b>최신 버전 앱</b>에서 이용할 수 있어요. Play 스토어에서 마음이음을 업데이트해 주세요.
            </div>
          ) : inApp ? (
            <button
              type="button"
              onClick={purchase}
              disabled={busy || !st || st.productIds.length === 0}
              className="flex w-full items-center justify-center rounded-2xl bg-teal-600 px-6 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-teal-700 disabled:opacity-50"
            >
              {busy ? "결제 창을 여는 중…" : st && st.productIds.length === 0 ? "준비 중입니다" : "구독하기"}
            </button>
          ) : (
            <div className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              구독 결제는 <b>마음이음 앱</b>에서 진행됩니다. 앱을 설치한 뒤 같은 계정으로 로그인해 주세요.
            </div>
          )
        )}

        {isPro && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            해지·결제수단 변경은 Google Play 스토어 → 메뉴 → 결제 및 정기 결제에서 할 수 있어요.
          </p>
        )}
      </div>
    </div>
  );
}
