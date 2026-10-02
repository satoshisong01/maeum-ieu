/**
 * 프록시 뒤에서 클라이언트 IP를 안전하게 뽑는다.
 *
 * ⚠ **왼쪽이 아니라 오른쪽에서 센다.** 이게 이 파일의 전부다.
 *
 *   `X-Forwarded-For`는 홉마다 **오른쪽에 덧붙는** 헤더다. 따라서 신뢰할 수 있는 값은
 *   우리 프록시가 마지막에 쓴 **맨 오른쪽**이고, 왼쪽은 전부 클라이언트가 보낸 그대로다.
 *
 *   결함(2026-10-02 AWS 이전 감사): app/api/auth/signup/route.ts가 `.split(",")[0]`로
 *   **맨 왼쪽**을 썼다. ALB는 실제 클라이언트 IP를 기존 XFF **뒤에** 붙이므로
 *   `X-Forwarded-For: <내가 지어낸 값>` 한 줄만 보내면 헤더가
 *   `<지어낸 값>, <진짜 IP>`가 되고, 코드는 지어낸 값을 키로 쓴다.
 *   → 값을 매번 바꾸면 **가입 레이트리밋(분당 10회)이 사실상 무제한**이 된다.
 *   미인증 엔드포인트라 봇이 계정을 무한 생성할 수 있고, 이 서비스는 가입만으로
 *   건강정보 스키마에 행을 만든다.
 *
 *   Vercel에서도 같은 논리 결함이지만, ALB는 "기존 값에 append"가 명세라 더 확실히 뚫린다.
 *
 * @param trustedHops 우리가 신뢰하는 프록시 홉 수(기본 1 = ALB 하나).
 *   CloudFront + ALB처럼 2단이면 env TRUSTED_PROXY_HOPS=2로 올린다.
 *   ⚠ 실제보다 크게 잡으면 클라이언트가 위조한 값을 집게 되므로, 모르면 1이 안전하다.
 */
export function getClientIp(req: Request, trustedHops?: number): string {
  const hops = (() => {
    if (typeof trustedHops === "number" && trustedHops > 0) return trustedHops;
    const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      // 오른쪽에서 hops번째 — 홉 수가 실제보다 많으면 맨 왼쪽으로 떨어지므로 하한을 둔다
      const idx = Math.max(0, parts.length - hops);
      const picked = parts[idx];
      if (picked) return picked;
    }
  }
  // XFF가 없으면 프록시가 직접 쓴 x-real-ip. 둘 다 없으면 식별 불가.
  return (req.headers.get("x-real-ip") || "unknown").trim();
}
