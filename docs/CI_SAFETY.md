# CI 안전성 자동 검증

마음이음 프로젝트의 CI(Continuous Integration) 자동 차단 시스템.
어르신 대상 서비스의 안정성 최우선 정책에 따라, 코드 변경 시 자동으로 안전성 검사를 실행합니다.

## 검사 항목

### 1. Prompt-leak Detector (가장 critical)

`scripts/check-prompt-leak.ts` — 특정 사용자의 사실 정보(가족 이름·지명 등)가
prompt 파일에 박혀있는지 검출. 2026-05-26 abc→rudtjrch 누수 사고의 root cause 차단.

**두 가지 모드**:

- **regex-only** (CI 자동, DB 불필요):
  ```bash
  npm run audit:prompt-leak:ci
  ```
  "큰아들 X"·"장남 X" 같이 placeholder 자리에 실제 한글 이름(2~3글자)이
  박혔는지 휴리스틱 검출. CI 환경(DATABASE_URL 없음)에서 안전.

- **full** (DB cross-check, 수동·cron 실행):
  ```bash
  npm run audit:prompt-leak
  ```
  실제 DB의 `family_member` / `user_profile` 에서 사용자 이름을 가져와
  prompt 파일과 cross-check. 가장 정확.

### 2. User-scope Audit (warning 모드)

`scripts/audit-user-scope.ts` — 모든 user-scoped DB 쿼리에 `user_id` 필터가
있는지 정적 분석. false positive 있어 strict가 아닌 review 가이드 용도.

```bash
npm run audit:user-scope
```

### 3. TypeScript 컴파일

`npx tsc --noEmit` — 타입 안전성 검증.

## 통합 명령

```bash
# Strict (CI 자동 실행) — fail 시 머지 차단
npm run ci:safety

# All-inclusive (수동) — user-scope warning 포함
npm run ci:safety:all
```

## GitHub Actions Workflows

### `.github/workflows/ci.yml` — 매 PR/push 자동 실행

- TypeScript 컴파일
- Prompt-leak (regex-only)
- User-scope audit (warning)

### `.github/workflows/prompt-leak-full.yml` — 운영자 수동 / 매일 새벽

- DB 접근하여 실제 사용자 이름으로 prompt cross-check
- Secret: `DATABASE_URL` (GitHub Secrets에 등록)
- Cron: `0 18 * * *` (UTC 18:00 = KST 03:00)

## 사고 사례 참고

- 2026-05-26 abc→rudtjrch 누수: constants.ts/prompt.ts에 "재미/영민"이 예시로 박혀
  모든 사용자 systemPrompt에 누출. 이 detector가 catch했더라면 코드 머지 전 차단 가능.

## 향후 보강

- pre-commit hook (Husky) — 로컬에서 commit 전 자동 실행
- E2E 골든 시나리오 30개 — playwright + eval-quality 자동화
- 2nd LLM cross-validation — Claude/GPT로 응답 안정성 검증
