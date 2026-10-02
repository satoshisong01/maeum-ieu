/**
 * 테스트 격리 자체의 회귀 고정 — 게이트를 지키는 게이트.
 *
 * 2026-10-02에 두 가지가 동시에 드러났다:
 *   ① 같은 파일에 서로 다른 목 체제를 두면 `vi.doMock`이 **간헐적으로** 먹지 않는다.
 *      → 유닛 테스트가 운영 RDS에 prisma.message.create를 날렸다(실측 5연속 실패/간헐 통과).
 *   ② 간헐 레드는 "전수 통과"라는 기록을 거짓으로 만든다. 한 번 통과한 걸 보고 끝냈기 때문이다.
 *
 * 그래서 두 가지를 고정한다: DB 차단 가드가 살아 있는지, 그리고 목 체제 분리 규칙이 남아 있는지.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

describe("실제 DB 차단 가드", () => {
  it("DATABASE_URL이 예약 도메인으로 교체돼 있다", () => {
    // 🔒 이게 깨지면 목이 빗나간 순간 유닛 테스트가 **운영 DB에 쓴다**
    expect(process.env.DATABASE_URL).toContain("unit-test-must-mock-lib-prisma.invalid");
  });

  it("호스트명이 예약 TLD(.invalid)라 해석조차 되지 않는다", () => {
    // 실제 호스트로 바뀌면 "연결 실패"가 아니라 "연결 성공"이 될 수 있다
    expect(process.env.DATABASE_URL).toMatch(/\.invalid(:\d+)?\//);
  });

  it("vitest.config.ts가 setupFiles로 가드를 로드한다", async () => {
    const cfg = await readFile("vitest.config.ts", "utf-8");
    // 🔒 setupFiles를 지우면 위 두 테스트도 같이 사라져 아무도 모른다
    expect(cfg).toMatch(/setupFiles:\s*\[\s*"\.\/__tests__\/setup\/no-real-db\.ts"/);
  });
});

describe("목 체제 하나당 파일 하나", () => {
  /** resetModules/doMock으로 레지스트리를 갈아끼우는 파일들 */
  const REGISTRY_FILES = [
    "__tests__/emergency-notify-isolated.test.ts",
    "__tests__/emergency-notify-decrypt.test.ts",
  ];

  it.each(REGISTRY_FILES)("%s 안에 describe가 하나뿐이다", async (file) => {
    const src = await readFile(file, "utf-8");
    const n = (src.match(/^describe\(/gm) ?? []).length;
    // 🔒 두 번째 describe가 붙는 순간 레이스가 돌아온다 — 새 파일로 분리할 것.
    //   (규칙을 사람 기억에 맡겼다가 두 번 당했다. 그래서 테스트로 박는다.)
    expect(n, `${file}에 describe ${n}개 — 목 체제를 나누려면 파일을 새로 만들 것`).toBe(1);
  });

  it("정리용 doUnmock이 남아 있지 않다 — 필요하다는 건 경계가 틀렸다는 신호", async () => {
    for (const file of REGISTRY_FILES) {
      const src = await readFile(file, "utf-8");
      const code = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"));
      expect(code.join("\n"), file).not.toMatch(/vi\.doUnmock/);
    }
  });
});
