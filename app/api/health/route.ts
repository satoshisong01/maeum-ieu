/**
 * GET /api/health — 로드밸런서 헬스체크.
 *
 * ⚠ **DB를 보지 않는다.** 이게 이 파일의 핵심 설계 결정이다.
 *
 *   ALB 타깃 그룹은 이 응답으로 인스턴스를 서비스에서 뺀다. 여기서 DB를 확인하면
 *   RDS 장애가 "전 인스턴스 unhealthy → ALB가 트래픽을 어디에도 못 보냄"으로 증폭된다.
 *   그 순간 /api/chat의 **최후 응급 안전망**(lib/chat/emergency-last-resort.ts)도 함께 죽는다.
 *   그 안전망은 DB 없이 119 안내와 보호자 알림을 내보내도록 일부러 만든 것인데,
 *   헬스체크가 먼저 인스턴스를 빼버리면 요청 자체가 도달하지 못한다.
 *   즉 "DB가 죽었을 때도 응급은 나간다"는 보장이 헬스체크 설계 하나로 무효가 된다.
 *
 *   따라서 여기서 보는 것은 **이 프로세스가 요청을 처리할 수 있는가**뿐이다.
 *   DB 상태는 모니터링·알람의 일이지 트래픽 라우팅의 입력이 아니다.
 *
 * 운영 주의:
 *   · ALB 타깃 그룹 Health check path = /api/health, 성공 코드 200.
 *   · middleware가 이 경로를 인증으로 막으면 ALB가 302/401을 받아 전 태스크를 뺀다 —
 *     아래 회귀 테스트(__tests__/health-endpoint.test.ts)가 matcher 제외를 고정한다.
 *   · 캐시 금지: 중간 캐시가 200을 붙들면 죽은 인스턴스가 살아 있는 것처럼 보인다.
 */
import { NextResponse } from "next/server";

/** 빌드 시점에 고정되는 식별자 — 어느 리비전이 떠 있는지 확인용(시크릿 아님) */
const REVISION = process.env.APP_REVISION?.trim() || "unknown";

export const dynamic = "force-dynamic";   // 정적 최적화 금지 — 항상 지금 상태를 돌려준다

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      revision: REVISION,
      uptimeSec: Math.round(process.uptime()),
      at: new Date().toISOString(),
      // ⚠ db 상태를 **의도적으로 넣지 않는다**(위 주석 참조).
      //   DB 가시성이 필요하면 /api/admin/overview나 별도 모니터링 경로를 쓸 것.
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
