import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { normalizeMode } from "@/lib/roles";
import { LogoutButton } from "./LogoutButton";

export default async function Home() {
  const session = await getServerSession(authOptions);

  // 로그아웃 상태 — 로그인/가입 랜딩
  if (!session?.user?.id) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4 dark:bg-[#0b0d10]">
        <main className="flex max-w-md flex-col items-center text-center">
          <h1 className="text-4xl font-bold text-zinc-800 dark:text-zinc-100">마음이음</h1>
          <p className="mt-3 text-zinc-600 dark:text-zinc-300">
            AI와 대화하며 일상과 마음 건강을 함께 살펴보는 서비스예요.
          </p>
          <div className="mt-10 flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
            <Link href="/login" className="rounded-full bg-[#007bff] px-8 py-4 font-medium text-white transition hover:bg-[#0069d9]">
              로그인
            </Link>
            <Link href="/signup" className="rounded-full border border-zinc-300 bg-white px-8 py-4 font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800">
              회원가입
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const mode = normalizeMode(session.user.screeningMode);

  // 의사·보호자·일반인은 각자의 역할 화면으로 (서버에서 결정 — 깜빡임 방지)
  if (mode === "pro" || mode === "guardian") redirect("/expert");
  if (mode === "general") redirect("/mental");

  // 어르신(user) — 건강정보 미동의면 동의 화면 먼저
  const u = await prisma.user.findUnique({ where: { id: session.user.id }, select: { consentedAt: true } });
  if (!u?.consentedAt) redirect("/consent");

  // 어르신 홈 — 큼지막한 [대화하기] + 하단 작은 3개 (치매 의심 어르신도 쉽게)
  const name = session.user.name?.trim();
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-sky-50 to-[#eef2f7] px-5 pb-6 pt-5 dark:from-[#0b1220] dark:to-[#0b0d10]">
      {/* 상단 인사 + 로그아웃 */}
      <header className="mx-auto flex w-full max-w-md items-center justify-between">
        <p className="text-lg font-semibold text-zinc-700 dark:text-zinc-200">
          안녕하세요{name ? `, ${name}님` : ""} 👋
        </p>
        <LogoutButton
          title="로그아웃"
          className="rounded-full p-2 text-zinc-400 hover:bg-white/70 hover:text-zinc-700 dark:hover:bg-zinc-800"
        />
      </header>

      {/* 대화하기 — 화면의 대부분을 차지하는 초대형 버튼 */}
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 pt-4">
        <Link
          href="/chat"
          className="flex flex-1 flex-col items-center justify-center gap-4 rounded-[2rem] bg-[#007bff] px-6 py-12 text-white shadow-xl shadow-blue-500/20 transition active:scale-[0.99] hover:bg-[#0069d9]"
        >
          <span className="text-7xl leading-none">📞</span>
          <span className="text-4xl font-extrabold tracking-tight">대화하기</span>
          <span className="text-lg font-medium text-blue-50/90">터치하고 편하게 말씀하세요</span>
        </Link>

        {/* 하단 작은 3개 */}
        <div className="grid grid-cols-3 gap-3">
          <HomeTile href="/observe" icon="👂" label="상시 감시" />
          <HomeTile href="/mypage" icon="⚙️" label="설정" />
          <HomeTile href="/help" icon="❓" label="도움말" />
        </div>
      </main>
    </div>
  );
}

/** 하단 작은 타일 버튼 — 큰 아이콘 + 라벨. */
function HomeTile({ href, icon, label }: { href: string; icon: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center justify-center gap-1.5 rounded-2xl bg-white px-2 py-5 text-center shadow-sm transition active:scale-95 hover:shadow-md dark:bg-zinc-900"
    >
      <span className="text-3xl leading-none">{icon}</span>
      <span className="text-base font-semibold text-zinc-700 dark:text-zinc-200">{label}</span>
    </Link>
  );
}
