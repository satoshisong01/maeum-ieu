import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export const authOptions: NextAuthOptions = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma 7.x와 @auth/prisma-adapter 타입 불일치 해결
  adapter: PrismaAdapter(prisma as any) as Adapter,
  // 민감 건강데이터 — 세션 30일 + 일일 롤링 갱신(활성 사용자는 재로그인 거의 없음).
  //   파일럿(3주) 대비 14→30일 연장(2026-07-07): 비밀번호 재설정 플로우가 없어 중도 만료 시
  //   어르신·보호자가 현장 도움 없이 재로그인하기 어려움. 파일럿 후 재설정 플로우와 함께 재검토.
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "이메일", type: "email" },
        password: { label: "비밀번호", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });
        if (!user?.password) return null;
        const ok = await bcrypt.compare(credentials.password, user.password);
        if (!ok) return null;
        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) token.id = user.id;
      // 프로필 수정·주기 갱신 시, 또는 토큰에 screeningMode가 없으면(기존 세션) DB에서 최신값 반영
      if (trigger === "update" || !token.name || token.screeningMode === undefined) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { name: true, screeningMode: true },
        });
        if (dbUser) {
          token.name = dbUser.name;
          token.screeningMode = dbUser.screeningMode === "pro" ? "pro" : dbUser.screeningMode === "general" ? "general" : "user";
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = token.name as string | null;
        session.user.screeningMode = token.screeningMode ?? "user";
      }
      return session;
    },
  },
};
