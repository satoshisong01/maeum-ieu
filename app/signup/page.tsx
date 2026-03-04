"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [age, setAge] = useState<string>("");
  const [gender, setGender] = useState<string>("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== passwordConfirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          passwordConfirm,
          name: name || undefined,
          age: age === "" ? undefined : parseInt(age, 10),
          gender: gender || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "회원가입에 실패했습니다.");
        return;
      }
      router.push("/login?registered=1");
    } catch {
      setError("회원가입 처리 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4 py-8">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="text-center text-2xl font-semibold text-zinc-800">마음이음</h1>
        <p className="mt-2 text-center text-sm text-zinc-500">회원가입</p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <input
            type="text"
            placeholder="이름 (선택)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
          />
          <input
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
            required
          />
          <input
            type="password"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
            required
            minLength={6}
          />
          <input
            type="password"
            placeholder="비밀번호 재확인"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
            required
            minLength={6}
          />
          <div className="flex gap-2">
            <input
              type="number"
              placeholder="나이 (선택)"
              min={1}
              max={120}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="w-24 rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
            />
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="flex-1 rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
            >
              <option value="">성별 (선택)</option>
              <option value="male">남성</option>
              <option value="female">여성</option>
              <option value="other">기타</option>
            </select>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-[#007bff] py-3 font-medium text-white transition hover:bg-[#0069d9] disabled:opacity-60"
          >
            {loading ? "가입 중..." : "회원가입"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-zinc-500">
          이미 계정이 있으신가요?{" "}
          <Link href="/login" className="font-medium text-[#007bff]">
            로그인
          </Link>
        </p>
      </div>
    </div>
  );
}
