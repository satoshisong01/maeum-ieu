import Link from "next/link";

/** 도움말 — 어르신용 간단 사용 안내(큰 글씨). 앱 홈의 [도움말] 버튼 대상. */
export default function HelpPage() {
  const items: { icon: string; title: string; body: string }[] = [
    { icon: "📞", title: "대화하기", body: "가운데 큰 파란 버튼을 누르고 편하게 말씀하세요. 마음이음이 대답하고, 가끔 먼저 말을 걸기도 해요. 약 드실 시간도 알려드려요." },
    { icon: "👂", title: "상시 감시", body: "등록한 목소리를 조용히 지켜보다가, 위급한 상황으로 보이면 보호자에게 자동으로 알려드리는 기능이에요. (베타)" },
    { icon: "⚙️", title: "설정", body: "이름, 약 먹는 시간 알림, 보호자·의사 연결 코드를 여기서 정할 수 있어요." },
  ];
  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-[#eef2f7] px-5 py-6 dark:from-[#0b1220] dark:to-[#0b0d10]">
      <div className="mx-auto max-w-md">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-3xl font-extrabold text-zinc-800 dark:text-zinc-100">도움말</h1>
          <Link href="/" className="rounded-full bg-white px-4 py-2 text-base font-semibold text-zinc-600 shadow-sm dark:bg-zinc-900 dark:text-zinc-300">← 홈</Link>
        </div>

        <div className="space-y-3">
          {items.map((it) => (
            <section key={it.title} className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
              <h2 className="flex items-center gap-2 text-xl font-bold text-zinc-800 dark:text-zinc-100">
                <span className="text-2xl">{it.icon}</span> {it.title}
              </h2>
              <p className="mt-2 text-lg leading-relaxed text-zinc-600 dark:text-zinc-300">{it.body}</p>
            </section>
          ))}

          <section className="rounded-2xl border-2 border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-900/20">
            <h2 className="text-xl font-bold text-red-700 dark:text-red-300">🚨 위급할 때</h2>
            <p className="mt-2 text-lg leading-relaxed text-red-700 dark:text-red-200">
              숨쉬기 힘들거나 가슴이 아프거나 크게 다치셨다면, 앱보다 먼저 <b>119</b>에 전화하세요.
            </p>
          </section>
        </div>

        <Link href="/chat" className="mt-6 flex items-center justify-center gap-2 rounded-2xl bg-[#007bff] px-6 py-5 text-xl font-bold text-white shadow-lg transition hover:bg-[#0069d9]">
          📞 지금 대화하기
        </Link>
      </div>
    </div>
  );
}
