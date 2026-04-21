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
  const [guardianName, setGuardianName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("");
  const [companionName, setCompanionName] = useState("");
  const [companionRelation, setCompanionRelation] = useState("");
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
          guardianName: guardianName || undefined,
          guardianPhone: guardianPhone || undefined,
          guardianRelation: guardianRelation || undefined,
          companionName: companionName || undefined,
          companionRelation: companionRelation || undefined,
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
          <hr className="border-zinc-100" />
          <p className="text-xs text-zinc-500">보호자 정보 (선택)</p>
          <input
            type="text"
            placeholder="보호자 이름"
            value={guardianName}
            onChange={(e) => setGuardianName(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
          />
          <input
            type="tel"
            placeholder="보호자 연락처 (010-0000-0000)"
            value={guardianPhone}
            onChange={(e) => setGuardianPhone(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
          />
          <select
            value={guardianRelation}
            onChange={(e) => setGuardianRelation(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
          >
            <option value="">보호자 관계 (선택)</option>
            <option value="son">아들</option>
            <option value="daughter">딸</option>
            <option value="spouse">배우자</option>
            <option value="grandchild">손자/손녀</option>
            <option value="other">기타</option>
          </select>
          <hr className="border-zinc-100" />
          <p className="text-xs text-zinc-500">AI 동반자 설정 (선택 — 비우면 기본값 "민지 / 손녀")</p>
          <input
            type="text"
            placeholder="AI 이름 (예: 민지, 수진, 지훈)"
            value={companionName}
            onChange={(e) => setCompanionName(e.target.value)}
            maxLength={10}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
          />
          <select
            value={companionRelation}
            onChange={(e) => setCompanionRelation(e.target.value)}
            className="rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
          >
            <option value="">AI 관계 (선택)</option>
            <option value="손녀">손녀</option>
            <option value="손자">손자</option>
            <option value="딸">딸</option>
            <option value="아들">아들</option>
            <option value="며느리">며느리</option>
            <option value="사위">사위</option>
            <option value="조카">조카</option>
            <option value="친구">친구</option>
          </select>
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
