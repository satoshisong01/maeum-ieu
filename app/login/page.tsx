"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";
import { LATEST_APP_VERSION, isOlderVersion } from "@/lib/app-version";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null); // RN 앱이 주입한 설치 버전(알 수 없으면 null)
  const [inApp, setInApp] = useState(false);   // RN 앱(WebView) 안에서 실행 중인지
  const [updateNeeded, setUpdateNeeded] = useState(false);

  // 저장된 아이디(이메일) 자동 채움
  useEffect(() => {
    const saved = localStorage.getItem("savedEmail");
    if (saved) { setEmail(saved); setRemember(true); }
  }, []);

  // 설치 앱 버전 확인 → 최신과 비교해 업데이트 안내
  //  - 앱이 버전 주입(window.MAEUM_APP_VERSION): 그 값으로 비교
  //  - 앱(ReactNativeWebView)인데 버전 미주입: 버전표시 이전 '구버전' → 업데이트 권장
  //  - 일반 브라우저: 해당 없음
  useEffect(() => {
    const w = window as unknown as { MAEUM_APP_VERSION?: string; ReactNativeWebView?: unknown };
    const isApp = !!w.ReactNativeWebView;
    setInApp(isApp);
    const v = w.MAEUM_APP_VERSION;
    if (typeof v === "string") {
      setAppVersion(v);
      setUpdateNeeded(isOlderVersion(v, LATEST_APP_VERSION));
    } else if (isApp) {
      setAppVersion(null);      // 버전 확인 불가(구버전)
      setUpdateNeeded(true);    // 업데이트 권장
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (res?.error) {
        setError("이메일 또는 비밀번호를 확인해 주세요.");
        return;
      }
      // 아이디 저장 — 체크 시 이메일 보관, 해제 시 삭제
      if (remember) localStorage.setItem("savedEmail", email);
      else localStorage.removeItem("savedEmail");
      // 역할별 랜딩은 홈(/)이 서버에서 결정 — pro는 /expert, 그 외 /chat. /chat 깜빡임 방지.
      window.location.href = "/";
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4 dark:bg-[#0b0d10]">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg dark:bg-zinc-900 dark:shadow-black/40">
        <h1 className="text-center text-2xl font-semibold text-zinc-800 dark:text-zinc-100">마음이음</h1>
        <p className="mt-2 text-center text-base text-zinc-600 dark:text-zinc-300">로그인</p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <input
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            required
          />
          <input
            type="password"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            required
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-[#007bff] focus:ring-2 focus:ring-blue-400 dark:border-zinc-600 dark:bg-zinc-800"
            />
            아이디 저장
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-[#007bff] py-4 text-base font-medium text-white transition hover:bg-[#0069d9] focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 disabled:opacity-60"
          >
            {loading ? "로그인 중..." : "로그인"}
          </button>
        </form>
        {/* 업데이트 안내 — 설치된 앱이 최신보다 낮을 때 */}
        {updateNeeded && (
          <div className="mt-3 rounded-xl border border-amber-400 bg-amber-50 px-3 py-2.5 text-center text-sm text-amber-800 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-200">
            ⚠️ 새 버전 <b>v{LATEST_APP_VERSION}</b>이 나왔어요. 아래에서 최신 앱으로 업데이트해 주세요.
            <span className="block text-xs text-amber-600 dark:text-amber-300/80">현재 버전: {appVersion ? `v${appVersion}` : "확인 불가(구버전)"}</span>
          </div>
        )}
        {/* 앱 다운로드 (임시 — Play Store 정식 배포 전까지 접근성용. 안드로이드 .apk) */}
        <a
          href="/maeum-app.apk"
          download="마음이음.apk"
          className={`mt-3 flex items-center justify-center gap-2 rounded-xl border py-4 text-base font-medium transition focus:outline-none focus:ring-2 ${updateNeeded ? "border-amber-500 bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-400" : "border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus:ring-emerald-400 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/40"}`}
        >
          {updateNeeded ? `⬆️ 최신 앱으로 업데이트 (v${LATEST_APP_VERSION})` : `📱 안드로이드 앱 다운로드 (v${LATEST_APP_VERSION})`}
        </a>
        <p className="mt-1 text-center text-xs text-zinc-400 dark:text-zinc-500">
          테스트용 · 안드로이드 전용(.apk)<br />
          {inApp && (
            <>현재 버전 {appVersion ? `v${appVersion}` : "확인 불가"}{appVersion && !updateNeeded && <span className="text-emerald-500"> ✓</span>} · </>
          )}
          최신 v{LATEST_APP_VERSION}
        </p>
        <p className="mt-6 text-center text-base text-zinc-600 dark:text-zinc-300">
          계정이 없으신가요?{" "}
          <Link href="/signup" className="font-medium text-[#007bff] dark:text-blue-400">
            회원가입
          </Link>
        </p>
      </div>
    </div>
  );
}
