"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

export default function ConsentPage() {
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleAgree() {
    if (!agreed) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/users/consent", { method: "POST" });
      if (!res.ok) {
        setError("처리에 실패했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      window.location.href = "/chat";
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-[#f0f2f5] px-4 py-8 dark:bg-[#0b0d10]">
      <div className="w-full max-w-lg rounded-2xl bg-white p-7 shadow-lg dark:bg-zinc-900">
        <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">건강정보 수집·이용 동의</h1>
        <p className="mt-2 text-base text-zinc-600 dark:text-zinc-300">
          마음이음은 어르신의 인지·마음 건강을 살피기 위해 아래 정보를 수집·이용합니다. 시작하시려면 동의가 필요해요.
        </p>

        <div className="mt-5 space-y-4 rounded-xl bg-zinc-50 p-4 text-[15px] leading-relaxed text-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-200">
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">① 수집 항목</p>
            <p>AI와 나눈 대화 내용 · 인지/마음 건강 상태 추정 결과 · 응급(위급) 신호 · 보호자 연락처(선택)</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">② 이용 목적</p>
            <p>인지·마음 건강 변화 관찰, 위급 상황 시 보호자에게 알림</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">③ 열람 범위 (중요)</p>
            <p>연결된 보호자·전문가는 <b>결과 요약과 ‘문제 있는 발화(응급)’만</b> 볼 수 있어요. <b>일상 대화 내용은 공개되지 않습니다.</b></p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">④ 보관·파기</p>
            <p>서비스 이용 기간 동안 안전하게 보관하고, 탈퇴 시 파기합니다. 연락처 등 민감정보는 암호화해 저장합니다.</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">⑤ 동의 철회</p>
            <p>언제든 마이페이지 또는 문의를 통해 동의를 철회할 수 있어요.</p>
          </div>
        </div>

        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 h-5 w-5 rounded border-zinc-300 text-[#007bff] focus:ring-2 focus:ring-blue-400 dark:border-zinc-600 dark:bg-zinc-800"
          />
          <span className="text-[15px] font-medium text-zinc-800 dark:text-zinc-100">
            위 내용을 확인했고, <b>건강정보(민감정보) 수집·이용에 동의</b>합니다.
          </span>
        </label>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

        <button
          type="button"
          onClick={handleAgree}
          disabled={!agreed || loading}
          className="mt-5 w-full rounded-xl bg-[#007bff] py-4 text-lg font-semibold text-white transition hover:bg-[#0069d9] disabled:opacity-50"
        >
          {loading ? "처리 중..." : "동의하고 시작하기"}
        </button>

        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-3 w-full text-center text-sm text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          동의하지 않고 나가기(로그아웃)
        </button>
      </div>
    </div>
  );
}
