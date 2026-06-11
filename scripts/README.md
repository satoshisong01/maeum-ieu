# scripts/ 디렉터리 구조

스크립트는 모두 **저장소 루트에서 실행**합니다 (예: `npx tsx scripts/safety-regression.ts`, `node scripts/test/e2e-tier.mjs`).
`dotenv/config`가 루트의 `.env`를 읽으므로 다른 디렉터리에서 실행하면 환경변수를 찾지 못합니다.

> ⚠️ **경고: `prisma db push`는 raw SQL 테이블(embeddings/assessments)을 drop합니다.**
> 스키마 변경 전 반드시 복구 준비를 하고, 사고 발생 시 `scripts/restore-raw-tables.ts`로 복구하세요.
> (안전 패턴: 수동 ALTER + `prisma generate`, `db push` 금지)

## 루트 — 운영·CI 필수 스크립트 (이동 금지)

package.json / CI(.github/workflows) / docs(CYCLE_FIXLOG 등) / 세션 메모리에서 경로로 참조되므로 위치를 옮기면 안 됩니다.

| 스크립트 | 설명 |
|---|---|
| `safety-regression.ts` | 안전망 회귀 테스트 (fact-check·회상누출·응급·JSON누출·이름정제 고정 케이스) |
| `audit-user-scope.ts` | 사용자 스코프 감사 — CI(`npm run audit:user-scope`)에서 실행 |
| `check-prompt-leak.ts` | 프롬프트 누출 검사 — CI(`npm run audit:prompt-leak[:ci]`)에서 실행 |
| `restore-raw-tables.ts` | **db push 사고 복구 도구** — raw SQL 테이블(embeddings/assessments) 재생성 |
| `rebuild-embeddings.ts` | RAG 임베딩 전체 재구축 |
| `backfill-summary.ts` | 대화 요약(weekly→monthly→yearly) 백필 |
| `backfill-honorific.ts` | 호칭 데이터 백필 |
| `backfill-profile.ts` | user_profile/family_member 슬롯 백필 |
| `eval-quality.ts` | 대화 품질·이상감지 자동 평가 파이프라인 (docs 참조) |
| `matrix-verify.ts` | 인지 분석기 매트릭스 검증 (docs 참조) |
| `tier-verify.ts` | 등급(severity tier) 산정 검증 (docs 참조) |
| `e2e-loop.mjs` | E2E 라운드 루프 — matrix/tier/screening/recall 일괄 실행 (docs 참조) |
| `e2e-screening.mjs` | 인지 선별 E2E (docs 참조) |
| `e2e-recall.mjs` | 회상 E2E — `e2e-loop.mjs`가 호출 |
| `e2e-adaptive.mjs` | 유동형(adaptive) E2E 사이클 (docs 참조) |
| `e2e-dynamic.mjs` | Claude 직접 운전 유동형 E2E (docs 참조) |
| `_check-scores.mjs` | 계정별 인지 점수 빠른 조회 (docs 참조) |
| `_last-msgs.mjs` | 최근 메시지 빠른 조회 (docs 참조) |
| `check-recent-ai.ts` | 최근 AI 응답 40건 조회 (범용 점검) |
| `check-today-cycle.ts` | 오늘 사이클(A/B/C) AI응답 vs DB판정 이중 대조 |
| `inspect-conv.ts` | 대화 ID 지정 메시지 전체 조회 (범용 점검) |
| `user-distribution.ts` | 사용자 분포 통계 |
| `set-companion.ts` | 계정별 AI 동반자 이름·관계 설정 |
| `compare-models.ts` | Gemini 모델 비교 |
| `compare-voices.ts` | TTS 음성 비교 |
| `strip-trace-backfill.ts` | reasoning trace 노출 메시지 정리 백필 |
| `convert-to-vertex-format.ts` | 파인튜닝용 Vertex AI 포맷 변환 |
| `extract-training-data.ts` | 파인튜닝 학습 데이터 추출 |
| `generate-training-data.ts` | 파인튜닝 학습 데이터 생성 |
| `generate-question-bank.mjs` | 사용자모드 질문풀 생성 (Gemini) |
| `merge-question-bank-v2.mjs` | 질문풀 검증·병합 |

## test/ — 테스트·검증 스크립트

- `test-*.ts`, `test-safety-gambling.mjs` — 모듈 단위 테스트 (moderation, emergency, medication, STT, TTS, 사투리, 호칭 등)
- `bulk-chat-100*.ts`, `bulk-chat-test*.ts` — 대량 채팅 부하·시나리오 테스트
- `cycle-test.ts`, `cycle-test-lite.ts`, `check-playwright-cycle.ts` — Playwright 사이클 테스트
- `e2e-tier.mjs` — 등급 E2E
- `judgment-verify.mjs`, `screening-verify.ts` — 판정·선별 검증
- `eval-range.ts` — 범위 지정 평가

## archive/ — 일회성 진단 (역사 보존용, 삭제 금지)

과거 사고·버그헌트 때 쓴 일회성 스크립트. 재사용 가치는 낮지만 사고 분석 이력 보존을 위해 유지합니다.

- abc/jaemi 누수 사고: `inspect-abc-leak.ts`, `find-jaemi-source.ts`, `purge-jaemi-embeddings.ts`, `cleanup-abc-jaemi.ts`
- 끝말잇기 버그: `find-wordchain-bug.ts`, `check-wordchain.ts`
- 호칭·요약기 진단: `diag-honorific.mjs`, `diag-summarizer-thinking.mjs`, `check-honorific.ts`
- 특정 사건 DB 점검: `check-db.ts`, `check-notes.ts`, `check-remaining.ts`, `check-test-accounts.ts`, `check-100turn-cycle.ts`
- 데이터 일괄 수정: `fix-fp.ts` (과거 FP 되돌리기), `find-context-bugs.ts`
- 임시 헬퍼: `_check-leak.mjs`, `_find-english.mjs`

## report/ — 리포트 생성

- `build-final-report-docx.mjs` — 최종 종합 리포트 .docx 생성
- `build-qa-report-docx.mjs` — QA 리포트 .docx 생성 (`docs/reports/qa-data-0609.json` 입력)
- `build-verification-docx.mjs` — 검증 리포트 .docx 생성
- `build-judgment-comprehensive-2026-06-04.mjs` — 판정 종합 리포트 (2026-06-04)
- `md-to-docx.cjs` — 마크다운 여러 개를 .docx 하나로 변환하는 범용 변환기
