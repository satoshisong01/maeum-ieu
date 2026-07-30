"use client";

import { signOut } from "next-auth/react";

/** 모든 화면 헤더 공통 로그아웃 버튼. className으로 화면별 톤 맞춤. children으로 아이콘 등 커스텀 표시. */
export function LogoutButton({ className, children, title, "aria-label": ariaLabel }: { className?: string; children?: React.ReactNode; title?: string; "aria-label"?: string }) {
  return (
    <button
      type="button"
      onClick={async () => { await signOut({ redirect: false }); window.location.href = "/login"; }}
      title={title ?? "로그아웃"}
      aria-label={ariaLabel ?? title ?? "로그아웃"}
      className={className ?? "text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"}
    >
      {children ?? "로그아웃"}
    </button>
  );
}
