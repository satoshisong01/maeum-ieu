"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";

interface Profile {
  id: string;
  name: string | null;
  email: string;
  age: number | null;
  gender: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianRelation: string | null;
  guardianEmail: string | null;
  guardianWebhookUrl: string | null;
  companionName: string | null;
  companionRelation: string | null;
  userHonorific: string | null;
  createdAt: string;
}

export default function MyPage() {
  const { status, update: updateSession } = useSession();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [guardianWebhookUrl, setGuardianWebhookUrl] = useState("");
  const [companionName, setCompanionName] = useState("");
  const [companionRelation, setCompanionRelation] = useState("");
  const [userHonorific, setUserHonorific] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
      return;
    }
    if (status === "authenticated") {
      fetch("/api/users/profile")
        .then((r) => r.json())
        .then((data: Profile) => {
          setProfile(data);
          setName(data.name ?? "");
          setAge(data.age != null ? String(data.age) : "");
          setGender(data.gender ?? "");
          setGuardianName(data.guardianName ?? "");
          setGuardianPhone(data.guardianPhone ?? "");
          setGuardianRelation(data.guardianRelation ?? "");
          setGuardianEmail(data.guardianEmail ?? "");
          setGuardianWebhookUrl(data.guardianWebhookUrl ?? "");
          setCompanionName(data.companionName ?? "");
          setCompanionRelation(data.companionRelation ?? "");
          setUserHonorific(data.userHonorific ?? "");
        })
        .catch(() => setError("프로필을 불러올 수 없습니다."));
    }
  }, [status, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");

    if (newPassword && newPassword !== newPasswordConfirm) {
      setError("새 비밀번호가 일치하지 않습니다.");
      return;
    }

    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        name: name || null,
        age: age === "" ? null : parseInt(age, 10),
        gender: gender || null,
        guardianName: guardianName || null,
        guardianPhone: guardianPhone || null,
        guardianRelation: guardianRelation || null,
        guardianEmail: guardianEmail || null,
        guardianWebhookUrl: guardianWebhookUrl || null,
        companionName: companionName || null,
        companionRelation: companionRelation || null,
        userHonorific: userHonorific || null,
      };
      if (newPassword) {
        body.currentPassword = currentPassword;
        body.newPassword = newPassword;
      }

      const res = await fetch("/api/users/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "수정에 실패했습니다.");
        return;
      }

      setProfile({ ...profile!, ...data });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      // 세션 갱신 — 헤더의 이름 등이 즉시 반영됨
      await updateSession({ name: data.name });
      setMessage("저장되었습니다.");
    } catch {
      setError("처리 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading" || !profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5] dark:bg-[#0b0d10]">
        <p className="text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-[#f0f2f5] px-4 py-8 dark:bg-[#0b0d10]">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-800 dark:text-zinc-100">마이페이지</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link href="/chat" className="text-sm text-[#007bff] hover:underline dark:text-blue-400">
              ← 대화
            </Link>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-lg dark:bg-zinc-900 dark:shadow-black/40">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* 이메일 (수정 불가) */}
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">이메일</label>
              <input
                type="email"
                value={profile.email}
                disabled
                className="w-full rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500"
              />
            </div>

            {/* 이름 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">이름</label>
              <input
                type="text"
                placeholder="이름"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>

            {/* 나이, 성별 */}
            <div className="flex gap-2">
              <div className="w-24">
                <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">나이</label>
                <input
                  type="number"
                  placeholder="나이"
                  min={1}
                  max={120}
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">성별</label>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="">선택 안 함</option>
                  <option value="male">남성</option>
                  <option value="female">여성</option>
                  <option value="other">기타</option>
                </select>
              </div>
            </div>

            {/* 구분선 */}
            <hr className="my-2 border-zinc-100 dark:border-zinc-700" />

            {/* 보호자 정보 */}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">보호자 정보 (선택)</p>
            <input
              type="text"
              placeholder="보호자 이름"
              value={guardianName}
              onChange={(e) => setGuardianName(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <input
              type="tel"
              placeholder="보호자 연락처 (010-0000-0000)"
              value={guardianPhone}
              onChange={(e) => setGuardianPhone(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <select
              value={guardianRelation}
              onChange={(e) => setGuardianRelation(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">보호자 관계 (선택)</option>
              <option value="son">아들</option>
              <option value="daughter">딸</option>
              <option value="spouse">배우자</option>
              <option value="grandchild">손자/손녀</option>
              <option value="other">기타</option>
            </select>
            <input
              type="email"
              placeholder="보호자 이메일 (응급 알림 수신)"
              value={guardianEmail}
              onChange={(e) => setGuardianEmail(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <div>
              <input
                type="url"
                placeholder="Webhook URL (Discord/Slack/IFTTT/Zapier 등)"
                value={guardianWebhookUrl}
                onChange={(e) => setGuardianWebhookUrl(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                응급 상황(L2/L3) 감지 시 이 URL로 POST 알림이 전송됩니다. 1시간 내 같은 카테고리는 중복 발송 차단됩니다.
              </p>
            </div>

            <hr className="my-2 border-zinc-100 dark:border-zinc-700" />

            {/* AI 동반자 설정 */}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">AI 동반자 설정 (비우면 "민지 / 손녀")</p>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">AI가 나를 부를 호칭</label>
              <select
                value={userHonorific}
                onChange={(e) => setUserHonorific(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="">자동 (나이/성별로 추천)</option>
                <option value="할아버지">할아버지</option>
                <option value="할머니">할머니</option>
                <option value="아버지">아버지</option>
                <option value="어머니">어머니</option>
                <option value="아빠">아빠</option>
                <option value="엄마">엄마</option>
                <option value="아저씨">아저씨</option>
                <option value="이모">이모</option>
                <option value="삼촌">삼촌</option>
                <option value="고모">고모</option>
              </select>
            </div>
            <input
              type="text"
              placeholder="AI 이름 (예: 민지, 수진, 지훈)"
              value={companionName}
              onChange={(e) => setCompanionName(e.target.value)}
              maxLength={10}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <select
              value={companionRelation}
              onChange={(e) => setCompanionRelation(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">AI 관계 선택</option>
              <option value="손녀">손녀</option>
              <option value="손자">손자</option>
              <option value="딸">딸</option>
              <option value="아들">아들</option>
              <option value="며느리">며느리</option>
              <option value="사위">사위</option>
              <option value="조카">조카</option>
              <option value="친구">친구</option>
            </select>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">* 변경 후 첫 1~2턴은 이전 호칭이 유지될 수 있어요.</p>

            <hr className="my-2 border-zinc-100 dark:border-zinc-700" />

            {/* 비밀번호 변경 */}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">비밀번호 변경 (선택)</p>
            <input
              type="password"
              placeholder="현재 비밀번호"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <input
              type="password"
              placeholder="새 비밀번호 (6자 이상)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={6}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <input
              type="password"
              placeholder="새 비밀번호 확인"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              minLength={6}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />

            {error && <p className="text-sm text-red-500">{error}</p>}
            {message && <p className="text-sm text-green-600">{message}</p>}

            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-[#007bff] py-3 font-medium text-white transition hover:bg-[#0069d9] disabled:opacity-60"
            >
              {loading ? "저장 중..." : "저장"}
            </button>
          </form>

          {/* 가입일 */}
          <p className="mt-4 text-center text-xs text-zinc-400">
            가입일: {new Date(profile.createdAt).toLocaleDateString("ko-KR")}
          </p>
        </div>
      </div>
    </div>
  );
}
