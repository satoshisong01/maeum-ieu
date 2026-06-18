"use client";

import { signOut } from "next-auth/react";

/** 모든 화면 헤더 공통 로그아웃 버튼. className으로 화면별 톤 맞춤. */
export function LogoutButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={async () => { await signOut({ redirect: false }); window.location.href = "/login"; }}
      title="로그아웃"
      className={className ?? "text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"}
    >
      로그아웃
    </button>
  );
}
