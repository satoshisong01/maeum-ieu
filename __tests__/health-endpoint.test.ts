/**
 * ALB 헬스체크 엔드포인트의 계약 고정.
 *
 * 배경 (2026-10-02 AWS 이전 감사): 나는 "app/api/health/route.ts가 이미 있다"고 보고했는데
 *   **틀렸다** — `ls app/api/health*`가 health-logs/를 매칭한 것이었다. 감사가 그걸 blocker로
 *   잡아냈고, 신설하면서 두 가지를 테스트로 못박는다.
 *
 * 🔒 (1) DB를 보지 않는다.
 *   ALB는 이 응답으로 인스턴스를 서비스에서 뺀다. 여기서 DB를 확인하면 RDS 장애가
 *   "전 인스턴스 unhealthy → 트래픽 갈 곳 없음"으로 증폭되고, 그 순간 DB 없이 동작하도록
 *   일부러 만든 **최후 응급 안전망**(lib/chat/emergency-last-resort.ts)까지 함께 죽는다.
 *   요청이 도달하지 못하면 안전망은 존재하지 않는 것과 같다.
 *
 * 🔒 (2) 인증으로 막히지 않는다.
 *   middleware matcher가 광범위 패턴(`/((?!_next).*)` 등)으로 바뀌면 ALB가 302/401을 받아
 *   **전 태스크를 뺀다**. 서비스 전면 중단이 설정 한 줄에서 난다.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { GET } from "@/app/api/health/route";

describe("헬스체크 응답", () => {
  it("200과 ok:true를 돌려준다", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("캐시를 금지한다 — 중간 캐시가 200을 붙들면 죽은 인스턴스가 살아 보인다", () => {
    expect(GET().headers.get("cache-control")).toMatch(/no-store/);
  });

  it("DB 상태를 응답에 담지 않는다", async () => {
    const body = await GET().json();
    for (const k of ["db", "database", "prisma"]) expect(body).not.toHaveProperty(k);
  });

  it("리비전·업타임으로 어느 인스턴스가 떠 있는지 식별할 수 있다", async () => {
    const body = await GET().json();
    expect(typeof body.revision).toBe("string");
    expect(typeof body.uptimeSec).toBe("number");
  });
});

describe("설계 계약 — 깨지면 전면 장애", () => {
  it("라우트가 prisma를 import하지 않는다", async () => {
    const src = await readFile("app/api/health/route.ts", "utf-8");
    // 🔒 DB를 보는 순간 RDS 장애가 전면 장애로 증폭된다
    expect(src).not.toMatch(/@\/lib\/prisma/);
    expect(src).not.toMatch(/prisma\./);
  });

  it("middleware가 /api/health를 인증으로 막지 않는다", async () => {
    const src = await readFile("middleware.ts", "utf-8");
    const m = src.match(/matcher:\s*\[([\s\S]*?)\]/);
    expect(m, "matcher 배열을 찾지 못했다").not.toBeNull();
    const entries = (m![1].match(/"[^"]*"/g) ?? []).map((x) => x.slice(1, -1));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      // 🔒 정규식/와일드카드 패턴이 들어오면 /api/health를 삼킬 수 있다 —
      //    경로 화이트리스트만 허용한다(지금 설계). 바꾸려면 이 테스트를 먼저 고쳐야 한다.
      expect(e, `matcher에 패턴이 들어왔다: ${e}`).toMatch(/^\/[a-z0-9\-/]*$/i);
      expect(e).not.toContain("api");
    }
  });
});
