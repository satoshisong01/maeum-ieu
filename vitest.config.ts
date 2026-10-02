import { defineConfig } from "vitest/config";
import path from "path";

/**
 * 커버리지 임계치의 목적은 "점수 올리기"가 아니다.
 *
 * 이 저장소의 반복 사고 유형은 **에러 없이 품질만 조용히 떨어지는 결함**이고,
 * 그게 반복된 구조적 이유는 게이트가 전부 행위/E2E라 **한 번도 실행되지 않은 분기**가
 * 보이지 않았다는 것이다. 실제로 2026-10-01 응급 복원력 수정 당시, 기존 게이트 4종
 * (tsc / vitest / safety-regression / notify-verify) 중 새 분기를 하나도 실행하는 것이 없었다
 * — 수정 전 코드로도 전부 통과했을 테스트였다.
 *
 * 그래서 임계치는 **안전 핵심 모듈에만** 건다. 전역 평균은 의미가 없다(테스트하기 쉬운
 * 유틸이 어려운 안전 경로의 공백을 가려버린다). 아래 목록은 "여기 분기가 안 지나면
 * 사람이 죽거나, 치매를 놓치거나, 돈이 샌다"에 해당하는 파일들이다.
 *
 * 임계치를 낮추는 것은 허용되지 않는다. 테스트를 추가하거나, 그 코드가 왜 도달 불가인지
 * 주석으로 증명하고 `coverage.exclude`에 근거와 함께 적어라.
 */
const SAFETY_CRITICAL = [
  "lib/chat/emergency.ts",
  "lib/chat/emergency-notify.ts",
  "lib/chat/emergency-llm.ts",
  "lib/usage/daily-limit.ts",
  "lib/billing/entitlement.ts",
  "lib/billing/plans.ts",
  "lib/chat/korean-particle.ts",
  "lib/health/severity.ts",
  "lib/test-accounts.ts",
];

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // 측정 대상을 안전 핵심으로 한정 — 전역 평균은 공백을 가린다(위 주석 참조).
      include: SAFETY_CRITICAL,
      /**
       * 래칫(ratchet) — 2026-10-02 실측을 바닥으로 고정했다. **올리기만 한다.**
       * 내리고 싶다면 그건 테스트를 지웠다는 뜻이고, 그 경우 docs/검증_가이드.md의
       * '임계치 변경 절차'를 따라 근거를 남겨야 한다.
       * 측정 범위는 SAFETY_CRITICAL 9개 파일뿐이며 safety-regression 342건이
       * __tests__/gate-scripts.test.ts를 통해 포함된다(그게 없으면 숫자가 거짓이 된다).
       */
      thresholds: {
        // 2026-10-02 경과: 41.3%(도입) → 57.2%(342건 포함해 정직화) → 80.5% → 85.3%.
        //   emergency-llm 0→100%, emergency-notify 26→79%, korean-particle 65→100%.
        //   남은 최저: emergency.ts 78.4%, emergency-notify.ts 79.1%.
        lines: 97,
        functions: 100,
        branches: 89,
        statements: 95,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
