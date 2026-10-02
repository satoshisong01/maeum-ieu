"use client";

import { useEffect, useState, useCallback } from "react";

type Theme = "light" | "dark" | "system";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark" || saved === "system") return saved;
  return "system";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  let isDark: boolean;
  if (theme === "system") {
    isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } else {
    isDark = theme === "dark";
  }
  if (isDark) root.classList.add("dark");
  else root.classList.remove("dark");
}

/** 우상단 등에 배치하는 라이트/다크 토글 버튼 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const t = getInitialTheme();
    // 테마는 localStorage·OS 설정에서 오므로 서버 렌더 시점에 알 수 없다. 마운트 후 확정하지
    //   않으면 하이드레이션 불일치가 난다(mounted 플래그와 짝을 이루는 의도된 패턴).
    //   1회만 실행되어 연쇄 렌더가 없다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(t);
    applyTheme(t);
    setMounted(true);

    // theme==='system'일 때 OS 변경 즉시 반영
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (localStorage.getItem("theme") === "system" || !localStorage.getItem("theme")) {
        applyTheme("system");
      }
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const cycle = useCallback(() => {
    const order: Theme[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    localStorage.setItem("theme", next);
    applyTheme(next);
  }, [theme]);

  if (!mounted) {
    return <button className={`h-9 w-9 ${className ?? ""}`} aria-hidden="true" />;
  }

  const icon = theme === "light" ? "☀" : theme === "dark" ? "☾" : "✦";
  const label = theme === "light" ? "라이트" : theme === "dark" ? "다크" : "시스템";

  return (
    <button
      type="button"
      onClick={cycle}
      title={`현재: ${label} 모드 — 눌러서 전환`}
      aria-label={`테마 변경: 현재 ${label}`}
      className={`flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 ${className ?? ""}`}
    >
      <span className="text-base leading-none">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
