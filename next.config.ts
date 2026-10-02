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
  // 화자식별(voiceprint): 모델·ORT WASM 런타임 모두 self-host(/models/, /ort/) — 외부 CDN 미사용.
  "connect-src 'self' wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com",
  "worker-src 'self' blob:",
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
  /**
   * self-host(Docker/ECS) 배포용 standalone 출력 (2026-10-02, AWS 이전 준비).
   *
   * 무엇이 달라지나: .next/standalone/ 아래에 **추적된 의존성만** 복사된 server.js가 나온다.
   *   node_modules 1.6G를 통째로 싣지 않아도 되므로 이미지가 수백 MB 줄고 콜드스타트가 빨라진다.
   *   Vercel 배포에는 영향이 없다(플랫폼이 자체 번들링을 한다).
   *
   * ⚠ standalone은 public/ 과 .next/static 을 **자동으로 복사하지 않는다.** Dockerfile에서
   *   따로 COPY해야 한다 — 빠뜨리면 화자식별 모델(32M)·ORT WASM(35M)·APK(51M)·정적 자산이
   *   전부 404가 되고, 증상이 "일부 화면만 깨짐"으로 나타나 원인 찾기가 어렵다.
   *
   * ⚠ prisma client는 generated/prisma/client(커스텀 output)에 생성된다. standalone 추적이
   *   잡아내지만, Docker 빌더 단계에서 `prisma generate`가 **반드시 먼저** 돌아야 한다.
   *
   * 참고: standalone server.js는 process.env.KEEP_ALIVE_TIMEOUT을 읽는다
   *   (next/dist/build/utils.js). ALB idle timeout보다 크게 잡아야 502가 안 난다 — Dockerfile 주석 참조.
   */
  /**
   * ⚠ **조건부**로 켠다. 지금 프로덕션은 아직 Vercel에 떠 있다.
   *   Vercel이 standalone 출력을 어떻게 다루는지 이 환경에서 검증할 수 없고, 추측으로 켰다가
   *   **살아 있는 서비스의 배포를 깨뜨리는 위험**을 감수할 이유가 없다.
   *   Docker 빌드만 BUILD_STANDALONE=1을 주입한다(Dockerfile 참조). 이전이 끝나고 Vercel을
   *   내린 뒤에는 이 분기를 지우고 무조건 standalone으로 바꾸면 된다.
   */
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
