import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function Home() {
  const session = await getServerSession(authOptions);
  if (session) redirect("/chat");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4">
      <main className="flex max-w-md flex-col items-center text-center">
        <h1 className="text-3xl font-bold text-zinc-800">마음이음</h1>
        <p className="mt-3 text-zinc-600">
          AI와 대화하며 일상과 상태를 함께 살펴보는 서비스예요.
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/login"
            className="rounded-full bg-[#007bff] px-8 py-4 font-medium text-white transition hover:bg-[#0069d9]"
          >
            로그인
          </Link>
          <Link
            href="/signup"
            className="rounded-full border border-zinc-300 bg-white px-8 py-4 font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            회원가입
          </Link>
        </div>
      </main>
    </div>
  );
}
