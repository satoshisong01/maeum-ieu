"use client";

import { signIn, getSession } from "next-auth/react";
import Link from "next/link";
import { useState } from "react";
import { ThemeToggle } from "../theme-toggle";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      // 전문가·보호자는 대화 화면이 아니라 연결된 환자 목록으로 — 본인은 검진 대상이 아님
      const session = await getSession();
      window.location.href = session?.user?.screeningMode === "pro" ? "/expert" : "/chat";
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
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-[#007bff] py-4 text-base font-medium text-white transition hover:bg-[#0069d9] focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 disabled:opacity-60"
          >
            {loading ? "로그인 중..." : "로그인"}
          </button>
        </form>
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
