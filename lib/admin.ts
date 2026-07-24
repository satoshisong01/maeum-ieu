/**
 * 관리자(admin) 판별 — 환경변수 허용목록 방식.
 *
 * DB 스키마 변경 없이(role 컬럼 마이그레이션 회피 — prisma db push 금지 프로젝트),
 * ADMIN_EMAILS(콤마 구분)에 등록된 이메일로 로그인한 계정만 관리자로 인정한다.
 * 예: ADMIN_EMAILS=admin@maeum.kr,owner@example.com
 *
 * 관리자 권한 범위: 운영 통계·회원 현황 열람(/admin). 일상 대화 "원문"은 관리자에게도
 * 비노출(동의서 §4 — 응급 발화 근거만 예외).
 */
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allow = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}

/** 관리자 세션 반환 — 아니면 null (호출측에서 403 처리) */
export async function getAdminSession(): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminEmail(session.user.email)) return null;
  return session;
}
