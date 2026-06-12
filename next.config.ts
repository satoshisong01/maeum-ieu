import type { NextConfig } from "next";

// CSP — Next.js 호환(인라인/eval 허용)이라 보호력은 제한적이나 외부 스크립트 주입은 차단.
//   외부 리소스(Gemini·날씨)는 서버측 호출이라 connect-src 'self'로 충분. 클라이언트 외부 리소스 추가 시 갱신 필요.
//   ⚠️ next.config 변경은 dev 서버 재시작 후 적용 — 배포/재시작 시 화면 로드 검증 권장.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Live 음성(베타): 클라가 ephemeral token으로 Gemini Live WS에 직결 — API key는 비노출(서버 발급 토큰만)
  "connect-src 'self' wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com",
  "media-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// 보안 헤더 — 민감 건강데이터 서비스 기본 방어.
const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },                     // 클릭재킹 방어
  { key: "X-Content-Type-Options", value: "nosniff" },           // MIME 스니핑 방어
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), microphone=(self), camera=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
