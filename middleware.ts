import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: { signIn: "/login" },
});

/**
 * 보호 경로 — 미인증 접근을 /login으로 보낸다.
 *
 * 데이터 자체는 전부 API에서 `getServerSession`으로 다시 막혀 있어(29개 라우트 전수 확인)
 * 여기서 누락돼도 유출은 페이지 셸 수준에 그친다. 다만 방어 일관성상 인증이 필요한
 * 화면은 모두 포함한다 — /admin·/observe·/voiceprint·/live가 빠져 있었다(2026-10-01 감사).
 *
 * ⚠️ /consent·/privacy·/account-deletion은 의도적으로 제외 —
 *   동의 전 사용자와 Play 심사자가 로그인 없이 열람해야 하는 공개 안내 페이지다.
 */
export const config = {
  matcher: ["/chat", "/dashboard", "/mypage", "/expert", "/mental", "/admin", "/observe", "/voiceprint", "/live"],
};
