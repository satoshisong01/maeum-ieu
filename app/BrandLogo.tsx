/**
 * 마음이음 브랜드 마크 + 회사(FIRST C&D) 로고.
 * 훅 없는 공유 컴포넌트 — 서버/클라이언트 컴포넌트 양쪽에서 사용 가능.
 */

const SIZES = {
  sm: { box: "h-7 w-7 rounded-xl", icon: 16, text: "text-lg" },
  md: { box: "h-10 w-10 rounded-2xl", icon: 22, text: "text-2xl" },
  lg: { box: "h-16 w-16 rounded-3xl", icon: 36, text: "text-4xl" },
} as const;

/** 앱 워드마크 — 그라데이션 하트 배지 + "마음이음" 그라데이션 글자. */
export function BrandLogo({ size = "md", className = "" }: { size?: keyof typeof SIZES; className?: string }) {
  const s = SIZES[size];
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className={`inline-flex ${s.box} items-center justify-center bg-gradient-to-br from-[#007bff] to-[#33a9d6] shadow-sm shadow-blue-500/20`}>
        <svg width={s.icon} height={s.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {/* 하트(마음) + 심박 라인(돌봄·건강) */}
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="#ffffff" />
          <path d="M5 11.5h3l1.4-2.6 2 4.4 1.5-2.9 1 1.1H19" stroke="#007bff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </span>
      <span className={`bg-gradient-to-r from-[#007bff] to-[#2c9ed3] bg-clip-text font-extrabold tracking-tight text-transparent ${s.text}`}>
        마음이음
      </span>
    </span>
  );
}

/** 회사 로고 — 하단 크레딧(제공: FIRST C&D) 또는 헤더용. 가로형 배너라 작은 높이로. */
export function CompanyLogo({ className = "", label = true, imgClassName = "h-5" }: { className?: string; label?: boolean; imgClassName?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {label && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">제공</span>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/first-cnd-logo.png" alt="FIRST C&D" className={`w-auto opacity-80 dark:opacity-90 ${imgClassName}`} />
    </span>
  );
}
