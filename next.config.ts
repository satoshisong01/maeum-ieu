import type { NextConfig } from "next";

// 보안 헤더 — 민감 건강데이터 서비스 기본 방어.
// (CSP는 인라인 스크립트/외부 리소스와 충돌해 앱이 깨질 수 있어 별도 검증 후 도입 — 추후.)
const securityHeaders = [
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
