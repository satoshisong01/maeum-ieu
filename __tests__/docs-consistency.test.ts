/**
 * 문서가 코드와 **다른 숫자를 말하는 것**을 막는다.
 *
 * 왜: docs/검증_가이드.md §2가 "현재 바닥 branches 57"이라고 적어둔 동안
 *   vitest.config.ts의 실제 임계치는 91이었다(2026-10-02 적발). 가이드가 게이트 기준을
 *   말하는 문서인데 그 숫자가 틀리면, 그걸 보고 판단한 사람이 **통과한 걸 실패로,
 *   실패한 걸 통과로** 읽는다. 문서의 거짓은 코드의 거짓과 같은 급이다(가이드 F6·F7).
 *
 * 숫자를 두 곳에 적어야 한다면 — 문서는 읽히기 위해 숫자가 필요하고, 설정은 돌기 위해
 *   필요하다 — 둘이 갈라지는 걸 **테스트가 막는 수밖에 없다.**
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const GUIDE = "docs/검증_가이드.md";

describe("검증_가이드 §2 래칫 수치 = vitest.config.ts thresholds", () => {
  it("네 지표가 모두 일치한다", async () => {
    const cfg = await readFile("vitest.config.ts", "utf-8");
    const guide = await readFile(GUIDE, "utf-8");

    const fromCfg = (k: string) => {
      const m = cfg.match(new RegExp(`${k}:\\s*(\\d+)`));
      expect(m, `vitest.config.ts에 ${k} 임계치 없음`).not.toBeNull();
      return Number(m![1]);
    };

    // 가이드의 "현재 바닥: lines 98 / functions 100 / branches 93 / statements 97" 한 줄을 읽는다
    const line = guide.split("\n").find((l) => l.includes("현재 바닥"));
    expect(line, `${GUIDE}에 '현재 바닥' 줄이 없다 — 래칫 규칙이 사라졌는지 확인할 것`).toBeTruthy();

    for (const k of ["lines", "functions", "branches", "statements"]) {
      const m = line!.match(new RegExp(`${k}\\s+(\\d+)`));
      expect(m, `'현재 바닥' 줄에 ${k} 없음`).not.toBeNull();
      // 🔒 어긋나면 둘 중 하나가 거짓이다. 고칠 쪽은 **문서**다(설정이 단일 출처).
      expect(Number(m![1]), `${k}: 가이드 ${m![1]} vs 설정 ${fromCfg(k)}`).toBe(fromCfg(k));
    }
  });
});

describe("검증_가이드 §6 린트 경고 래칫 = ci.yml --max-warnings", () => {
  it("두 숫자가 같다", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf-8");
    const guide = await readFile(GUIDE, "utf-8");
    const inCi = ci.match(/eslint \. --max-warnings (\d+)/);
    expect(inCi, "ci.yml에 --max-warnings가 없다 — 경고가 다시 조용히 늘어난다").not.toBeNull();
    const inGuide = guide.match(/현재 경고 바닥: (\d+)/);
    expect(inGuide, "가이드 §6에 경고 바닥 수치가 없다").not.toBeNull();
    // 🔒 2026-10-06: "경고는 추적한다"고만 적어둔 사이 215 → 217 → 220으로 늘었다
    expect(Number(inGuide![1]), `가이드 ${inGuide![1]} vs CI ${inCi![1]}`).toBe(Number(inCi![1]));
    // 명령 예시도 같은 숫자여야 한다(복사해서 돌리는 사람이 다른 기준으로 통과시키지 않게)
    expect(guide).toContain(`eslint . --max-warnings ${inCi![1]}`);
  });
});

describe("가이드가 실재하는 산출물을 가리킨다", () => {
  it("가이드가 언급한 스크립트·설정 파일이 모두 존재한다", async () => {
    const guide = await readFile(GUIDE, "utf-8");
    const refs = [...guide.matchAll(/`((?:scripts|docs|lib|__tests__)\/[\w./-]+\.(?:ts|mjs|md))`/g)]
      .map((m) => m[1]);
    expect(refs.length, "가이드가 아무 파일도 가리키지 않는다").toBeGreaterThan(3);

    const missing: string[] = [];
    for (const r of new Set(refs)) {
      try { await readFile(r, "utf-8"); } catch { missing.push(r); }
    }
    // 🔒 "이 스크립트를 돌려라"가 존재하지 않는 파일을 가리키면, 그 단계는 조용히 건너뛰어진다
    expect(missing, `가이드가 없는 파일을 가리킨다: ${missing.join(", ")}`).toEqual([]);
  });

  it("가이드가 언급한 `npm run <스크립트>`가 package.json에 모두 있다", async () => {
    const guide = await readFile(GUIDE, "utf-8");
    const pkg = JSON.parse(await readFile("package.json", "utf-8")) as { scripts: Record<string, string> };
    const named = [...guide.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(named.length, "가이드가 npm 스크립트를 하나도 언급하지 않는다").toBeGreaterThan(3);
    const missing = [...new Set(named)].filter((n) => !(n in pkg.scripts));
    expect(missing, `package.json에 없는 스크립트: ${missing.join(", ")}`).toEqual([]);
  });
});
