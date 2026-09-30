import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { normalizeMode } from "@/lib/roles";
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
        // 이메일 정규화 — 저장·조회를 소문자로 통일 (2026-10-01 권한 상승 결함 수정).
        //   isAdminEmail은 대소문자를 무시해 비교하는데 가입·로그인은 정규화하지 않아,
        //   관리자 이메일의 대문자 변형("Admin@x.com")으로 가입하면 Postgres unique(대소문자 구분)를
        //   통과해 별도 계정이 만들어지고 그 계정이 관리자 권한을 얻었다.
        //   부수 효과로 "Kim@x.com"으로 가입한 어르신이 "kim@x.com"으로 로그인하면 실패했다.
        // ⚠ 정규화 이전에 만들어진 대문자 이메일 계정을 살리기 위해 원문으로 한 번 더 조회한다
        //   (현 DB 317명에는 대문자 이메일이 없음을 확인했으나, 안전하게 폴백을 둔다).
        const raw = credentials.email.trim();
        const normalized = raw.toLowerCase();
        const user = (await prisma.user.findUnique({ where: { email: normalized } }))
          ?? (normalized !== raw ? await prisma.user.findUnique({ where: { email: raw } }) : null);
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
          token.screeningMode = normalizeMode(dbUser.screeningMode);
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
