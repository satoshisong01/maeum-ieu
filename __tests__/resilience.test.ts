/**
 * 장애 내성 회귀 — "완전한 침묵"과 "조용한 유실"을 막는 장치들 (2026-10-01 감사).
 *
 * 세 가지를 고정한다:
 *  1. 모든 LLM 호출에 타임아웃이 걸려 있는가 (없으면 Gemini가 매달릴 때 어르신 화면이 침묵)
 *  2. 배경 작업이 after()로 실행 보장되는가 (부유 프라미스는 서버리스 freeze 시 유실)
 *  3. GEMINI_API_KEY 미설정 시 getTextModel이 throw하지 않는가 (throw면 500 → 빈 화면)
 *
 * 성격: 화이트박스 소스 계약 검증 + 단위. 리팩터링으로 조용히 되돌아가는 것을 막는 것이 목적이다.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { LLM_TIMEOUT_MS, timeoutSignal, getTextModel } from "@/lib/chat/llm";

describe("LLM 타임아웃", () => {
  it("용도별 상한이 정의되고 합리적 범위다", () => {
    expect(LLM_TIMEOUT_MS.companion).toBeGreaterThan(5_000);
    expect(LLM_TIMEOUT_MS.companion).toBeLessThanOrEqual(30_000);
    // 응급 백스톱은 응답 전 블로킹이라 가장 짧아야 한다
    expect(LLM_TIMEOUT_MS.emergency).toBeLessThan(LLM_TIMEOUT_MS.companion);
    // 배경 작업은 응답을 막지 않으므로 가장 여유
    expect(LLM_TIMEOUT_MS.background).toBeGreaterThanOrEqual(LLM_TIMEOUT_MS.companion);
  });

  it("timeoutSignal이 AbortSignal을 돌려주고 실제로 중단된다", async () => {
    const sig = timeoutSignal(20);
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig!.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(sig!.aborted).toBe(true);
  });

  it("매 호출마다 새 시그널을 만든다 — 재사용하면 두 번째 호출이 즉시 취소된다", () => {
    expect(timeoutSignal(1000)).not.toBe(timeoutSignal(1000));
  });

  const CALL_SITES: Array<[string, string]> = [
    ["lib/chat/llm.ts", "동반자 대화"],
    ["lib/chat/emergency-llm.ts", "응급 백스톱"],
    ["lib/chat/cognitive-analyzer.ts", "인지 분석기"],
    ["lib/chat/summarizer.ts", "요약기"],
    ["lib/screening/exam-runner.ts", "검진 채점"],
    ["app/api/chat/route.ts", "음성 전사(STT)"],
  ];

  it.each(CALL_SITES)("%s (%s) 의 LLM 호출에 abortSignal이 있다", async (path) => {
    const src = await readFile(path, "utf-8");
    expect(src).toMatch(/abortSignal/);
  });
});

describe("배경 작업 실행 보장 — after()", () => {
  it("메인 대화 경로의 인지분석·프로필·요약이 after()로 감싸여 있다", async () => {
    const src = await readFile("app/api/chat/route.ts", "utf-8");
    // 부유 프라미스(.catch만 달고 await 없이 호출)로 남아 있으면 서버리스에서 유실된다.
    const floating = /^\s*(?:if \(mode !== "general"\) )?runCognitiveAnalysis\(\{[^}]*\}\)\.catch/m;
    expect(src).not.toMatch(floating);
    // after()로 감싼 묶음이 두 경로(음성·텍스트) 모두에 있어야 한다
    const afterBlocks = src.match(/try \{ after\(bgTasks\); \}/g) ?? [];
    expect(afterBlocks.length).toBe(2);
  });

  it("RAG 임베딩 저장도 after()로 보장된다", async () => {
    const src = await readFile("lib/chat/messages.ts", "utf-8");
    expect(src).toMatch(/after\(embedTasks\)/);
    expect(src).not.toMatch(/^\s*saveMessageEmbedding\([^)]*\)\.catch/m);
  });
});

describe("환경변수 미설정 시 빈 화면 방지", () => {
  it("GEMINI_API_KEY가 없어도 getTextModel이 throw하지 않는다", () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      // 키 캐시(_genAI 싱글톤)가 이미 초기화돼 있으면 throw 자체가 일어나지 않는다.
      // 어떤 경우든 **동기 throw는 없어야** 한다 — 그게 500 → 빈 화면의 원인이었다.
      expect(() => getTextModel("test", false)).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });

  it("필수 env 점검이 빌드 전 게이트로 연결돼 있다", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf-8"));
    expect(pkg.scripts.prebuild).toMatch(/check-env/);
  });
});
