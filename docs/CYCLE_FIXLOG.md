# 사이클 Fix-Log (Cycle Fix Log)

> **목적**: 라이브 사이클(Playwright 대화 테스트 → 문제 파악 → 수정)에서 발견한 **문제·원인·수정 내역**을 영구 누적한다.
> 새 대화창/세션에서 작업을 이어받을 때 **이 파일만 읽으면 직전까지의 결함·수정 상태를 즉시 파악**할 수 있도록 유지한다.
>
> ## 작성 규칙
> - 사이클마다 섹션 추가 (날짜 + 사이클 번호).
> - 각 이슈: `발견(증상) → 원인(root cause) → 수정(파일:라인, 기능적/구조적 우선) → 검증` 순.
> - **프롬프트만 수정 X** — 기능적으로 견고해지는 구조적 수정을 우선. 현재 방안이 좋으면 강화.
> - DB 과거 데이터의 결함은 fix 이전 흔적일 수 있음 → **라이브 재현 여부로 현재 결함인지 판단**.
> - 미해결 이슈는 `[ ] OPEN` 으로 남기고, 해결 시 `[x] DONE` 으로 갱신.
>
> ## ⚠️ 테스트 철학 (사용자 지침, 2026-05-29)
> - **결함을 억지로 찾는 게 목적이 아니다.** 우리가 만든 기능을 **자연스러운 대화로 검증**하고,
>   그 과정에서 **일반인이 봐도 이상한 응답**이 나올 때만 문제로 보고 고친다.
> - 사람도 실수하고 잘못 말한다 — 완벽주의 잣대로 latent/이론적 결함을 몰지 말 것.
> - **한 계정만 쓰면 편향**되므로 여러 계정으로 교차 검증 (abc@abc.com=대화 최다, rudtjrch, test_indep 등).
> - 슬롯에 약간 지저분한 데이터가 있어도 **AI 출력이 정상이면 실사용 문제 아님** (예: 슬롯 "민호라"지만
>   LLM이 맥락으로 "김민호" 정확 출력 → 비문제. 단 파인튜닝 데이터 추출 시점엔 정리 고려).
>
> ## 운영 환경 메모
> - dev 서버: `npm run dev` (포트 3000). lib 파일 수정 시 재시작 필요할 수 있음.
> - 서버 재시작 시 stdout 캡처: `npm run dev > dev-server.log 2>&1 &` 후 `dev-server.log` 확인.
> - 자동 평가: `npx tsx scripts/eval-quality.ts <conversationId> <lastN>` (인자 없으면 최근 대화)
> - 안전망 회귀 테스트: `npx tsx scripts/safety-regression.ts` (exit 0=PASS)
> - 최근 대화 ID 조회: DB 직접 (`Message` 의 conversationId GROUP BY MAX createdAt).
> - Playwright 송신: `input[placeholder="메시지를 입력하세요."]`에 nativeInputValueSetter로 주입 후 `form.requestSubmit()`.
> - 관련 메모리: `feedback_cognitive_analysis_debugging`, `project_eval_pipeline`, `feedback_safety_net_patterns`.

---

## 2026-05-29 · Cycle A (Opus 4.8 라이브 사이클)

### 진행 상태: ✅ 1차 완료 (라이브 9턴 PASS, 기능 fix 3건 + 조사 1건). 다음 세션에서 이어가기 가능.

### 발견 이슈

#### A-1 🟠→✅ grounding wholesale fallback이 정상 발화에 간헐적 오발화
- **증상 (라이브 재현)**: "민지야 우리 단어 외우기 한번 해볼래" (정상 단어게임 요청) →
  AI: "민지가 다시 한 번 여쭤볼게요. 방금 말씀하신 내용을 좀 더 자세히 알려주실 수 있으세요?"
  (= 회피성 re-ask. 단어게임을 시작하지 못함). **비결정적** — 재시도 시 정상 응답("나무, 자동차, 모자…") 나옴.
- **root cause**: `lib/chat/fact-checker.ts` wholesale 교체가 정밀 name-checker(`ungrounded`)와 **무관하게**
  `FACT_NOUN` 점수만으로 발동. 구체 명사 1개만 매칭돼 0/1=0.0 score가 나오면 멀쩡한 응답이 통째로 re-ask로 교체됨.
- **수정 (구조적)**:
  - `calculateGrounding` → `GroundingDetail{score,total,ungrounded}` 반환하도록 리팩토링.
  - wholesale fallback 게이트 강화: `groundingScore<0.15 && total>=3 && ungrounded>=3 && length>120 && !emotional && !fact && !emergency`.
    → 구체 명사 1~2개 노이즈로는 발동 안 함. 진짜 환각 밀집 응답에만 backstop.
  - 진짜 환각(이름 다수)은 기존 `removeUngroundedClaims`(문장 단위 정밀 제거)가 처리 — 변경 없음.
- **검증**: `scripts/_tmp-factcheck.ts` — single-noisy-noun(칼국수) clobbered=false ✓ /
  dense-ungrounded(민수·영희·철수·순자) 정밀 제거로 자연 정리 ✓ / 단어게임·지식답변 grounding=1.00 ✓.
- **상태**: [x] DONE (라이브 재검증 진행)

#### A-2 🟡→✅ 회상 정답 strip 후 깨진 문장 조각
- **증상**: "단어 세 개는 나무, 자동차, 모자**입니다**. 기억나세요?" →
  `stripRecallAnswerLeak`이 정답을 제거하면 "단어 세 개는 **. **기억나세요?" 비문 발생.
  (라이브는 미재현이나, `scripts/_tmp-recall.ts`로 잠재 결함 결정적 확인.)
- **root cause**: `lib/chat/korean-particle.ts` `stripRecallAnswerLeak` — (1) 계사 suffix 목록에
  `입니다/이고/이며/이라고…` 누락 → 정답만 잘리고 계사 잔여, (2) 정답 제거 후 끊긴 lead-in("세 개는 .") 미정리.
- **수정 (강화)**:
  - `COPULA_TAIL` 상수로 계사·종결어미 목록 확장(입니다/이고/이며/이지/이라고/랍니다/이야 등) — quoted·bare 양쪽 적용.
  - 정답 제거 후 끊긴 lead-in 복원: `"...세 개는 . 기억나세요?"` → `"...세 개, 기억나세요?"`,
    문장 끝 매달린 조사 제거, 고립 종결부호 앞 공백/콤마 정리.
- **검증**: `scripts/_tmp-recall.ts` — 입니다/예요/였는데 케이스 전부 자연 복원, 정상 대화(과일 나열) 오제거 0건.
- **상태**: [x] DONE

#### A-3 🟢→✅ 원본 JSON 누출 예방 하드닝 (Cycle B에서 보완 완료)
- **증상 (과거 DB, 2002 월드컵 등 옛 날짜)**: `{"text": "...", "isAnomaly": true, "analysisNote...}` 가
  사용자에게 그대로 노출.
- **원인**: 모델이 컨텍스트의 인지분석 JSON 지시를 본문에 흘렸고 `extractText`가 그대로 반환.
- **수정 (기능적 하드닝)**: `lib/chat/sanitize.ts::salvageJsonLeak` 신규 — `extractText`가 호출.
  본문이 JSON 객체(`{` + `"key":` 시그니처)면 text/response/message/응답 등 필드만 추출,
  truncated JSON이면 정규식으로 text 필드 복구, 살릴 수 없으면 빈 문자열(→ fallback). 일반 텍스트는 그대로 통과.
- **검증**: `safety-regression.ts` A-3 5케이스 PASS (full/truncated/fenced 추출, plain 통과, text없는 JSON 공백화).
  라이브: 일반 대화("김치찌개 간이 짜") 정상 응답 유지 — 오작동 없음 확인.
- **상태**: [x] DONE

#### A-4 🔴→✅ 자살 ideation 활용형 누락 (안전 갭, 라이브 발견·수정)
- **증상 (라이브 재현)**: "다 부질없다 그냥 조용히 **사라져버리고** 싶어" → 109 자살예방 안내 미발동,
  일반 공감 응답으로 빠짐. (반면 "사라지고 싶어"는 정상 발동 → **비일관**)
- **root cause**: `lib/chat/emergency.ts` L3 suicidal 패턴이 `사라지(?:고\s*싶|버리고\s*싶|면\s*좋겠)` —
  활용형 "사라**져**버리고"(사라지→사라져)를 못 잡음. `버리고 싶` 분기는 "사라지버리고"를 기대하는 dead branch.
- **수정 (안전 강화)**:
  - `사라(?:지|져)\s*(?:고\s*싶|버리|버려|면\s*좋겠)` 로 활용형(사라지/사라져) 모두 커버 + `없어져 버리(고 싶)` 추가.
  - `lib/chat/fact-checker.ts` isEmergencyOrSafety 가드도 동일 활용형 반영(응급 발화 fallback 절대 차단 일관).
- **검증**: `scripts/_tmp-emergency.ts` 9/9 PASS — 활용형 6종 L3 포착 +
  정상문("구름이 사라졌어"/"통증이 사라져서"/"고민이 사라졌으면") 오탐 0. 라이브 재전송 → 109 안내 정상 출력 ✓.
- **상태**: [x] DONE

#### A-5 🔍 조사 결과 (버그 아님 — 설계 문서화): 응급 vs 인지이상 트랙 분리
- **배경**: eval-quality에 자해 시그니처를 GT로 넣었더니 "사라져버리고 싶어"가 FN으로 잡힘.
- **조사**: L3 응급(`app/api/chat/route.ts:835` handleEmergencyL3)은 early-return → `runCognitiveAnalysis` 미실행.
  `saveMessages`는 `emergencyLevel`/`emergencyEvidence`만 저장하고 `isAnomaly`는 set 안 함(`markAnomaly` 미호출).
- **판정**: 대시보드는 **두 트랙** — 응급(`emergencyLevel` 표시 + 보호자 알림) / 인지이상(`isAnomaly`·`cognitive_assessments` 통계).
  자살 ideation은 **응급 트랙으로 정상 기록·알림**되며, 인지이상 통계에서 빠지는 건 임상적으로 올바른 분리.
  → **제품 결함 아님.** eval GT에 자해 시그니처 추가는 축 혼동이므로 **롤백**함.
- **상태**: [x] DONE (문서화)

### eval-quality 결과 메모 (cmmn2n4pl 최근 12턴)
- 반복질문 0%, 호칭오류 0, 시간라벨누출 0.
- 할루시 명사 4건(책·전화)은 모두 eval-GT 오탐 — AI가 정당하게 쓴 응급/정정 단어. (측정 도구 한계, 제품 정상)
- 이상감지 Recall 100% / Precision은 표본 적음 + 분석기 보수성으로 변동. FP는 분석기가 더 민감한 케이스(회상 되묻기 등)로
  명백한 제품 오류 아님. (GT 휴리스틱 한계 — 과거 베이스라인과 일관)

### 이번 사이클 라이브 PASS (회귀 없음 확인)
- 단어게임 시작 → 정상(나무·자동차·모자) / 회상 재질문 → 정답 미노출·비문 없음
- 사망인물(이순신) → 정중한 reorientation, grounding fix가 정정 응답 보존
- 감정+이름충돌("재미가 없어", 아들 이름 재미) → 공감, 이름 혼동·로봇 re-ask 없음
- 약 오용("또 한 알 더") → 119 응급 안내
- 자살 ideation 활용형("사라져버리고 싶어") → 109 안내 (A-4 fix 후)

### 수정한 파일 (이번 사이클)
- `lib/chat/fact-checker.ts` — grounding wholesale fallback 게이트 강화(A-1) + isEmergency 활용형(A-4)
- `lib/chat/korean-particle.ts` — `stripRecallAnswerLeak` 계사 suffix 확장 + lead-in 정리(A-2)
- `lib/chat/emergency.ts` — L3 suicidal 패턴 활용형 커버(A-4)
- `scripts/eval-quality.ts` — eval GT 주석 보강(자해는 emergency 트랙임을 명시, A-5)
- **`scripts/safety-regression.ts` (신규·영구)** — A-1/A-2/A-4 결정적 회귀 테스트 15케이스.
  `npx tsx scripts/safety-regression.ts` (exit 0=PASS). lib/chat 안전망 수정 후·PR 전 실행.
  (사이클 중 쓰던 임시 `_tmp-*.ts`는 이걸로 통합·삭제함.)

---

## 2026-05-29 · Cycle B (다계정 자연 대화 검증)

### 진행 상태: ✅ 검증 통과 — 신규 fix 없음 (기능 정상 동작 확인)

테스트 철학 적용: 자연스러운 대화로 기능 검증, 진짜 이상만 문제로 판단.

### rudtjrch 계정 (맥락유지·반복질문)
- 구체 정보 2건("부대찌개"+"천안 두정동") 제공 → AI가 둘 다 인지 + 새 질문 (재질문 없음) ✓
- 짧은 답("그냥 쉬려고") → 직전 정보 재질문 없이 thread 이어감 ✓

### abc@abc.com 계정 (대화 최다, 자연 대화 5턴)
- 아침 산책 일상 → 자연 공감 + 호칭 "할아버지" 일관 ✓
- "사람 구경하는 **재미**가 쏠쏠" → "재미"를 단어로 정확 처리(이름충돌 회피) ✓
- 손주 그리움 → 따뜻한 공감 + 이름 환각 없음("손주분" generic) ✓
- "오늘 무슨 요일?" → "2026년 5월 29일 금요일" 정확(실제 오늘과 일치) ✓
- "적적함 덜하다 고맙다" → 공감 마무리, fallback 오발화 없음 ✓

### 판단 보류/비문제 처리
- rudtjrch `family_member.son(1)` 슬롯이 "민호라"(추출기가 `민호라고`→`민호라`로 캡처).
  **그러나 AI 출력은 "김민호"로 정상** (LLM이 맥락 보정) → 실사용 문제 아님.
  추출기 `cleanName`에 라고-quotative 처리는 *파인튜닝 데이터 정리 시점*에 옵션으로만 고려. (강제 X)

### 결론
2계정 교차 자연 대화에서 호칭·맥락·공감·지남력·이름충돌·환각방지 모두 정상. Cycle A의 3개 fix 외 추가 결함 없음.

### Cycle B 보완 (2026-05-29 추가 — 발견 항목 보완 후 추가 테스트)
- **A-3 JSON 누출 방어 구현** (위 A-3 [x] DONE 참조). `lib/chat/sanitize.ts` 신규 + `extractText` 연결.
- **민호라 추출기 보완**: `profile-extractor.ts::cleanName` — 인용어미 "라고" 흡수 보정
  (길이 ≥3 + 끝 "라" 제거, 2글자 라-이름 보라/세라/미라 보호). export하여 회귀 테스트 커버.
- **기존 슬롯 데이터 교정**: rudtjrch `son(1)` "민호라"→"민호" (사용자 권한 승인 후 1행 UPDATE).
  ※ 사용자 지침: 이 건은 실사용 무해(LLM이 "김민호" 정확 출력)했어서 필수 아님 — latent 데이터 정리 차원.
- **계정 독립성 재검증 (누수 없음)**: abc 계정 "큰아들 이름?"→"민호" 응답이 **abc 본인 발화("큰아들 이름이 민호야")
  기반 정상 데이터**임을 DB로 확인. rudtjrch에서 누수된 것 아님. (두 테스트 계정에 우연히 둘 다 민호 son 존재)
- **회귀 테스트 확장**: `safety-regression.ts` → **26/26 PASS** (A-1/A-2/A-3/A-4 + cleanName). tsc 0 에러.

### 수정/추가 파일 (Cycle B 보완)
- `lib/chat/sanitize.ts` (신규) — salvageJsonLeak
- `app/api/chat/route.ts` — extractText가 salvageJsonLeak 사용 (inline 함수 → lib 분리)
- `lib/chat/profile-extractor.ts` — cleanName 라고 보정 + export
- `scripts/safety-regression.ts` — A-3 + cleanName 케이스 추가 (총 26)

---

## 2026-05-29 · Cycle C (신규 계정 첫 대화 검증 + 능동 대화 로드맵)

### 신규 계정 검증 (cycle_test_2026@example.com / test1234!, 박순자 78세, 커스텀 동반자 "지윤/손녀/할머니")
- **AI 먼저 첫 인사 ✓**: 진입 시 자동으로 "안녕하세요, 할머니! 저는 할머니의 손녀 지윤이에요…" (DB msg 0).
  ※ `app/chat/page.tsx` 진입 effect → `POST /api/chat {isInitialGreeting:true}` → `handleFirstGreeting`.
- **커스텀 동반자 ✓**: companionName=지윤 / relation=손녀 / honorific=할머니 모두 정확 반영.
- **계정 독립성 ✓ (누수 0)**: "큰아들 이름 기억하니?" → "지윤이가 아직 모르고 있었네요, 알려주시면 기억할게요"
  — 신규 계정은 가족 정보 없음, 기존 계정(abc/rudtjrch)에서 누수 전혀 없음.
- **이름 재질문 자가보정 ✓**: 첫 응답에선 자기소개 반복금지 룰로 이름 생략했으나, 재차 물으니 "저는 지윤이에요" 정확히 밝힘.
- **결론**: 첫 대화부터 프로필 축적·커스텀·독립성·공감 모두 정상. 신규 결함 없음.

### 🛣️ 로드맵 — 능동 대화(AI-initiated) [핵심 기능, 사용자 비전 2026-05-29]
현재 상태:
- ✅ 첫 진입 시 AI 먼저 인사 (`isInitialGreeting`).
- ✅ 2시간 이상 경과 후 재진입 시 AI 먼저 재인사 (`app/chat/page.tsx` RETURNING_THRESHOLD_MS=2h, `isReturningGreeting`).
- ✅ 복약/일과 알림 폴링(1분) → due 시 AI 먼저 멘트 (`/api/medications/check`).

향후(IoT always-on 환경) 목표 — 웹은 제약 있으나 IoT는 상시 가동 가정:
- 대화 공백 N시간 후 AI가 먼저 말 검 (식사 후 복귀 등).
- **비음성 인기척 감지**(문소리/발소리 등)로 사용자 복귀 추정 → 능동 대화 트리거.
- 시간대·일과 맥락 기반 선제 대화(예: 아침 약 시간, 저녁 안부).
- → 설계 시 트리거 소스(타이머/센서/일정)와 멘트 생성(`handleReturningGreeting` 계열)을 분리한 이벤트 기반 구조 권장.

---

## 2026-05-29 · Cycle D (전 기능 통합 자연 대화 검증)

### 진행 상태: ✅ 전 기능 PASS — 결함 0건

신규 계정(박순자 할머니/지윤)으로 1회 자연 대화 흐름에 6개 핵심 기능 통합 검증:
1. **프로필 축적** — "큰딸 영숙/막내아들 준호" → "영숙 따님, 준호 아드님" 정확 인지 ✓
2. **공감 + grounded 이름** — "영숙이 바빠서 서운" → "영숙 따님이 바쁘셔서…" 공감 (환각 없음) ✓
3. **실시간 회상** — "막내아들 이름 뭐였더라" → "준호 아드님이세요! 방금 직접 말씀해주셨는데" ✓
4. **경미 증상 판단** — "무릎 시큰" → 찜질 제안, 119 과잉 에스컬레이션 안 함 ✓
5. **날짜 지남력 + 맥락유지** — "오늘 며칠?" → "5월 29일 금요일" + 무릎 재확인(4턴 맥락 기억) ✓
6. **인지이상 감지 + 부드러운 정정** — "박정희 생중계 봤어" → isAnomaly:true + "오래전 돌아가신 분…옛날 연설/꿈?" + 무릎 이어감 ✓

호칭(할머니)·동반자(지윤) 일관, 맥락 연속성(무릎 4→5→6턴) 자연스러움. **추가 fix 불필요.**

---

## 2026-06-01 · 이어가기(핸드오프) 메모 — 인지 선별 적응형 검증

### 현재 상태
- **앱 포트: :3100** (⚠️ :3000은 다른 프로젝트 energy-platform가 점유 중). dev: `npm run dev -- -p 3100 > dev-server-3100.log 2>&1 &`
- 검증 페르소나 계정: `cycle_test_2026@example.com` / `test1234!` (동반자 지윤·손녀·호칭 할머니). 다른 e2e 계정도 test1234!.
- 로컬 커밋 5건이 origin보다 앞섬(미push): 762be8b/c130777/dc23a8a/2d8b37c/3a0f155.

### 검증 도구(스크립트)
- `scripts/matrix-verify.ts` — 항목×강도 매트릭스(판단 엔진 직접). 100%.
- `scripts/tier-verify.ts` — 4단계 등급(정상/경증/중증/고위험) 경계·시나리오. 35/35.
- `scripts/e2e-screening.mjs` `e2e-recall.mjs` `e2e-tier.mjs` — 실제 앱 Playwright e2e.
- `scripts/e2e-loop.mjs` — 연속 루프(matrix+tier+anomaly+recall). 누적 `docs/리포트_누적.md`.
- `scripts/safety-regression.ts` — 안전망 26케이스.

### 적응형(양방향) 대화 검증 방법 (핵심)
- **Playwright MCP로 한 턴씩 직접 조작**: navigate :3100/login → 로그인 → "글씨로 대화하기" → 입력창에 nativeInputValueSetter로 주입 후 form.requestSubmit() → AI 응답 읽고 어르신 페르소나로 적응 응답.
- 점수 확인: DB `cognitive_assessments`(domain/score) + `[cognitive-analysis]` 서버 로그.

### 이번 적응형 세션서 발견·수정한 버그 2건 (커밋됨)
1. 시간 지남력 **근소 날짜오차 오탐**(정상 "5월 말"을 주의로) → cognitive-analyzer 시간섹션 보완 (2d8b37c).
2. 단어 등록 시 **외울 단어가 ****로 사라짐**(stripRecallAnswerLeak가 "기억해주세요"에 오발동) → 등록 가드 추가 (3a0f155).

### 다음 할 일 (이어서)
- 적응형 양방향 대화를 **훨씬 길게(수십 턴), 여러 페르소나/계정으로** 반복 (장소·100-7 연속빼기·따라말하기 등 미시연 항목 포함).
- 발견 이슈는 원인분석→수정→`safety-regression`+`matrix-verify`로 회귀 확인→보고서(`docs/리포트_적응형대화_검증`) 보강.
- 마지막에 로컬 커밋 push 여부 결정.

---

## 2026-06-01 · Cycle (적응형 장기 세션 #2) — fact-checker 동반자 이름 버그 2건

### 진행 상태: ✅ 버그 2건 발견·수정·회귀완료 (아직 커밋 안 함)

`cycle_test_2026`(동반자 지윤) 한 계정에서 6영역 정상/이상 혼합 12턴 적응형 대화 (`docs/리포트_적응형대화_검증.md` §9).
- 정상 5/5 → score 0 (오탐 0), 이상 4/4 → score 2, 종합등급 0.846→1.167(중증) 단조 상승.

### 발견·수정 버그 2건 (둘 다 root cause = **fact-checker가 동적 동반자 이름을 모름**)
1. **이름 누출**: `lib/chat/fact-checker.ts` grounding fallback 3곳 하드코딩 "민지" → 커스텀 동반자(지윤)인데 "민지가…" 노출.
   fix: `CheckInput.companionName` 추가 + 호출부(route.ts 텍스트·음성 2곳) 전달 + `nameSubj(companionName)` 동적화.
2. **응답 공백화(침묵 실패, 더 심각)**: fact-checker가 AI 자기지칭 "지윤이도…"의 "지윤"을 ungrounded 가족이름으로 오판→문장 통삭제→**빈 응답 저장**(어르신 화면 빈 말풍선). `NAME_STOPWORDS`엔 기본 "민지"만 있고 커스텀 미포함.
   fix: ungrounded 루프에서 `stripNameSuffix(name)===selfName(=companionName) → continue`(자기이름 항상 grounded). 라이브 재전송으로 정상 응답 복구 확인.

### 회귀 (영구)
- `scripts/safety-regression.ts` A-6 섹션 4케이스 추가 → **26→30/30 PASS**.
- `scripts/matrix-verify.ts` **26/27**(분석기 미변경, calc2b 1회 무판정=기존 비결정성). `tsc` 0.

### 수정/추가 파일
- `lib/chat/fact-checker.ts` — CheckInput.companionName, selfName 제외 가드, fallback 3곳 동적화, nameSubj import.
- `app/api/chat/route.ts` — factCheckResponse 호출 2곳에 companionName 전달.
- `scripts/safety-regression.ts` — A-6 4케이스(+selfName 보존).
- `scripts/_check-scores.mjs`(신규·검증헬퍼) — 이메일별 최근 발화×assessment + overallAvg 종합등급. `node scripts/_check-scores.mjs <email> [n]`.
- `scripts/_last-msgs.mjs`(신규·검증헬퍼) — 최근 메시지 role+content (빈 응답 탐지용).

### 미push 로컬 커밋: 이전 5건 + 이번 fix(아직 커밋 안 함). push 여부는 사용자 결정 대기.

---

## 2026-06-02 · Cycle (gemini-3.5-flash 영어누출 + 민지누출 + 빈응답 가드)

### 진행 상태: ✅ 3건 발견·수정·클린 10사이클 검증완료 (아직 커밋 안 함)

기준 모델 `gemini-3.5-flash` 전환 후 적응형 10사이클(10페르소나×~30턴) 라이브 검증. 최종 클린 결과: **300턴 · 빈응답 0 · 영어누출 0 · 민지누출 0 · strict 98/100** (2.5의 93 대비↑).

### 발견·수정 3건

1. **영어(추론·도구코드) 누출** — 3.5 응답에 영어 thought/googleSearch 흔적 노출.
   - 증상: `print(google_search.search(...)) thought The user...`, `Final Polish:`, `Let's check ... User:...AI:...`, `* No time labels`.
   - 원인: `extractText`가 `res.response.text()`로 thought part까지 합침 + `stripReasoningTrace`는 **앞쪽** 비한글 세그먼트만 제거(뒤/중간 누출 미처리).
   - fix: (Fix1) `extractText` — parts에서 `thought:true` 제외하고 text part만 추출. (Fix3) `stripReasoningTrace` — 도구코드 코드블록 제거 + 추론마커(`print(`/`google_search`/`Final Polish`/`Let's check`/`User:`/`AI:`/`the user wants` 등) 세그먼트를 **위치 무관** 제거 + 한글비율<0.3·영단어4+ 세그먼트 제거(전부 제거 시 원본 유지 가드).
   - ⚠️ (Fix2 시도→철회) `generationConfig.thinkingConfig.thinkingBudget:0`로 thinking 억제 시도 → **추론필요 턴에서 빈응답 다발**(1·2차 스모크 빈1·회피4). 제거하니 회피 0. **Fix1+Fix3만으로 누출 0 충분** → thinkingBudget 안 씀.

2. **빈 응답 저장(침묵 실패)** — 후처리 체인이 정상 응답을 통째로 깎아 빈문자열 → fallback 우회 없이 빈 저장.
   - 원인: `route.ts` 응답경로(텍스트 ~1172 / 음성 ~940)에서 `removeUngroundedClaims`/`removeParrot`/`trimIncomplete` 등이 응답을 0자로 만들어도 그대로 `saveMessages`.
   - fix: 후처리 직후 `if (!text || !text.trim()) text = fallback;` 가드(양 경로). 빈 말풍선 대신 graceful 재질문 멘트.

3. **민지 이름 누출(잔여분)** — 클린 10사이클 Cycle 7(동반자 "햇살")에서 `"민지가 재미있는 단어 세 개..."` 1건.
   - 원인: 프롬프트 예시의 **리터럴 "민지"**(renderSystemPrompt `{COMPANION_NAME}` 치환을 안 거침). ① `lib/chat/constants.ts` 예시 6곳. ② `route.ts` 동적 주입 힌트 `buildRecallVerificationHint`(단어회상)·`buildInfoRequestHint`(헷갈림) — Cycle 7은 "헷갈리네"로 후자 트리거.
   - fix: constants.ts 6곳 → `{COMPANION_NAME}`. route.ts 힌트 2함수에 `companionName` 파라미터 추가 + `nameSubj(companionName)` 보간 + 호출부 4곳(텍스트·음성×2) 전달.

### 회귀·검증 (영구)
- 클린 10사이클(STAMP 1780374117365) DB ground truth: **300턴 빈0·영어0·민지0**. strict 98/100.
- `scripts/safety-regression.ts` **30/30 PASS**, `tsc` 0.
- `stripReasoningTrace` 단위검증 6/6(누출 6패턴 제거 + 정상한글·영문이름 보존).

### 측정 교훈 (재확인)
- **e2e 실행 중 파일 조작 절대 금지**: 1차 10사이클 도중 `_progress.mjs` 생성·gitignore 편집 → 핫리로드로 Cycle 6 **UI 읽기 오염**(빈 10건 오탐, DB는 30건 정상). 재실행은 무편집으로 클린 확보. (DB가 ground truth — e2e UI 읽기 실패와 실제 빈응답 구분은 DB로 판정.)

### 수정/추가 파일
- `app/api/chat/route.ts` — extractText(thought 제외), stripReasoningTrace(전면 강화), getTextModel(thinkingConfig 미사용), 빈응답 가드 2곳, buildRecallVerificationHint·buildInfoRequestHint companionName 파라미터화 + 호출부 4곳.
- `lib/chat/constants.ts` — 프롬프트 예시 리터럴 "민지" 6곳 → `{COMPANION_NAME}`.
- `app/api/tts/route.ts` — sanitizeForTts(물결표 낭독 방지, 기존 working tree).
- `lib/chat/cognitive-analyzer.ts` — 자동기록 evidence/note 정상범위 문구(기존 working tree).
- `scripts/e2e-adaptive.mjs` — 모델라벨 파일명/헤더, NAME_LEAK "민지"만 감지(기존 working tree).
- `.gitignore` — `.playwright-mcp/` + `docs/리포트_*`·`검증결과_*`·`종합검증_*`·`판단검증_*` 추적 제외(생성 리포트 17 + playwright 33 untrack).

### 라이브 유동형 검증 (Claude ↔ Gemini 3.5, Playwright MCP)
- `scripts/e2e-dynamic.mjs`(신규) — LLM-in-the-loop 자동 대화(어르신=Gemini 2.5 생성기 ↔ 앱=3.5). headed 지원.
- 추가로 **Claude(에이전트)가 직접 Playwright MCP로 어르신 역할** 수행 6턴(`cycle_test_2026`/동반자 지윤): 영어0·민지0·빈0. 헷갈림(infoHint)·단어게임(블랭킹)·시간오지남력(1950→2026 정정) 라이브 통과.

### [x] DONE — 회상 정답 노출(memory_delayed 안전망 경계 사례) — 커밋 cf7e153
- 증상(라이브 재현): 어르신이 외운 단어 3개 중 2개만 회상하고 마지막을 못 떠올리자, AI가 "마지막 하나는 '소나무'였어요"라고 **정답을 알려줌**.
- 원인: ① constants.ts memory_delayed 규칙이 "정답 같이 노출" 케이스만 막고 "회상 실패 후 정답 채워주기"는 미커버. ② "[사용자 정보 혼동 시 정보 제공]" 규칙이 인지검사 단어에까지 과적용. ③ stripRecallAnswerLeak이 다중단어 노출만 잡고 단일단어 확인은 미검출.
- fix: ① memory_delayed에 "회상 실패 시에도 정답 노출 금지" 규칙 + 위로 응답 가이드 추가. ② 정보제공 규칙에 "자전적 정보에만 해당, 인지검사 항목 제외" carve-out. ③ stripRecallAnswerLeak에 "마지막/나머지 하나는 X였어요" 단일단어 구조적 차단(단어/회상 맥락 한정).
- 검증: 단위 6/6(누출 3 제거·안전 3 보존), tsc 0, safety 30/30.

---

## 2026-06-02 · 전반 점검(Opus 4.8 + 아키텍처·보안 에이전트) — 종합 개선

> 사용자 요청: "시간문제처럼 전반적으로 개선할 점을 훑어 점검·수정하고, 보호자 알림(C2) 제외 코드 가능한 것 모두 처리 + 테스트 + 보고서."
> Opus 4.8 직접 리뷰(임상 검출 핵심) + architect 에이전트(아키텍처) + security-architect 에이전트(보안) 3축 점검 후 수정.

### ✅ 해결(커밋)
| 항목 | 등급 | 내용 | 커밋 |
|------|------|------|------|
| 임상 교란변수 5건 | HIGH | 음력·세는나이·자가정정→정답·청력·교육(학력보정) 오탐 차단 | b7bfd01 |
| 섬망(급성 혼동) | HIGH | 신체증상+급성혼동 동반 시 가역원인 의심 노트 | b7bfd01 |
| H3 멱등성 | HIGH | cognitive_assessments 결정적 id + ON CONFLICT(중복 INSERT→등급왜곡 차단) | b7bfd01 |
| 웹훅 SSRF + rate limit | HIGH | 가디언 웹훅 사설/메타데이터 IP 차단 + chat 40/분 | b7bfd01 |
| **C1 급성 악화 감지** | CRIT | 최근 vs 베이스라인 윈도우 비교 + 도메인 가중상한 | af7de2d |
| H2 분석기 견고화 | HIGH | responseSchema(truncation 평가유실 방지) + temp 0 | 69d16f7 |
| M3 confidence 게이트 | MED | 저신뢰 score2 강제anomaly 억제(오경보 감소) | 6e78318 |
| H4 검증 정합 | HIGH | judgment-verify 등급계산을 production(computeOverallAvg)과 일치 | 73b3b55 |
| M2 googleSearch 조건부 | MED | info_request 의도에만 검색(비용·지연 절감) | 08477aa |
| #8 보안 | MED | 보안헤더·비번최소·rag SQL 방어적 파라미터화 | 99684e8 |
| **#9 판단검증 2배** | — | 워크플로(생성→적대적검증) 65→110케이스, 분석기 110/110 | 0709c49 |
| #7 lexicon 통합 | LOW | 사망인물·비현실·최근접촉 3~4중복 → lexicons.ts(STRICT/LOOSE) | b504466 |
| B1 PII 로깅 마스킹 | MED | 발화원문·가족이름·고향/취미 값 로그 제거(건수만) | b504466 |
| B2 가성치매 감별 | MED | 우울성 저수행 ≠ 인지저하 → 보수채점+GDS 노트 | b504466 |
| B3 평가범위 명시 | MED | summary에 평가불가(시공간·그리기·실행기능)+disclaimer | b504466 |
| **B4 영구 베이스라인** | CRIT | 최초 14일 고정 기준선 대비 현재 → 완만한 장기 저하 감지 | c4d7b75 |
| B5/B6/B7 보안 | MED | Zod 경계검증·JWT 30→14일·CSP 헤더 | 944a704 |
| #6/H1 후처리 파이프라인 | HIGH | 11단 체인 → 명시적 순서+단계별 관측 로깅+중복제거 | 06fa22c |

### 검증
- judgment-verify 109/110(확장; 경증 1건 "잠깐 헷갈렸네"류는 0/1 임상경계로 분석기가 정상 판정—방어가능, 회귀 아님), matrix-verify 81/81(100%), safety-regression 30/30, tsc 0 전부 통과.
- SQL injection(rag) 에이전트 CRITICAL 주장은 **과장**으로 확인(입력이 [가-힣]만이라 악용불가) → 방어적 파라미터화만.

### [ ] 미해결 / 보류 (코드 너머·제품 결정 필요)
- **[보류] C2 인지등급 → 보호자 알림**: 알림 방식 논의 중(사용자). C1/B4가 급성·장기 저하를 *감지*하나, 보호자 *전달* 경로는 C2 개발 전까지 비어 있음. → notifyGuardian을 trend.status/baselineTrend.status 소비하도록 연결 필요(디바운스 포함).
- **[ ] 동의(consent) 모델 + 저장 암호화(at-rest)**: 취약계층 건강데이터 규제 대응 — 인프라·정책 결정 필요.
- **[ ] M1 핸들러 병합**: handleAudioMessage/handleTextMessage ~90% 중복. 음성·텍스트 미세차이 유실 위험 커 신중한 별도 작업 필요(build*Hint·history 모듈 추출 포함).
- **[ ] cognitive_assessments Prisma 마이그레이션 편입**: 현재 raw SQL이라 db push가 drop 위험(과거 데이터 유실 이력). UNIQUE(message_id,domain)도 정식 제약으로.
- **[ ] CSP 런타임 검증**: next.config 변경이라 dev 재시작 후 화면 로드·콘솔 위반 확인 필요.
- **[ ] 경증 경계 케이스 노이즈**: "잠깐 헷갈렸네"류 0/1 경계는 temp0에서도 가끔 flip(임상적으로 모호). 테스트 영향 미미.

---

## 2026-06-10 — 60턴 사이클 (스크립트 30 + 실시간 30, Fable 5 일괄 개선 직후 검증)

### 배경
같은 날 진행한 일괄 개선(모더레이션 FP·분석기 thinkingBudget+2단 라우팅·mode 서버검증·스트림 재시도·프롬프트 캐시 재배열·postprocess 분리 등)의 라이브 검증.
- **스크립트형 30턴** (e2e-dynamic, 김순자 페르소나): 빈응답 0 · 누출 0 · 오탐 0, 평가 9건 전부 정상 채점.
- **실시간 30턴** (Claude가 Playwright MCP로 직접 운전, cycle_test_2026 계정): 이상 시나리오 **6/6 전부 감지**(사망인물 직접접촉/해운대/1972년/호랑이/가족이름 망각/계산오답), 정상 시나리오 **오탐 0**(음력 생일·난청 되묻기·농담 정정·사망인물 미디어·정상날짜 모두 클린). 부분회상(2/3)은 정확히 score 1 경계 채점. 전체 69건 평가.
- **개선 실측**: 2단 라우팅 작동(lite:3.5 = 3:1), 분석기 thinking 0토큰(이전 ~2900), 분석기 입력 캐시 적중 ~3.9k/턴(이전 0), "떡을 먹었지"/"불이 꺼져서" 정상 통과, 회상 정답 노출 재발 없음.

### 발견·수정 4건
| 문제 | 심각도 | Fix | 검증 |
|---|---|---|---|
| **JSON 응답 UI 비표시** | CRIT | 스트리밍 도입(06-05) 후 LLM 우회 경로(날짜즉답·모더레이션·응급 L3·STT실패)가 SSE 파서에 막혀 텍스트모드 UI에 안 보임 — 응급 안내까지 비표시. streamAndSpeak에 content-type JSON 분기 추가 | 라이브: "지금 몇 시야?" 즉답 표시 확인 |
| 3인칭 직함 호칭 치환 | HIGH | normalizeHonorific TITLE 치환이 무가드라 "김구 선생님은"→"김구 할머니은"(조사 깨짐 포함). 이름 lookbehind 제외 + 조사 받침 교정(eunNeun/iGa) | vitest 5케이스 |
| 한국어 thinking 누출 | HIGH | "(생각) …다고 한다." 한국어 사고 트레이스가 stripReasoningTrace(영문 패턴만) 통과. 한국어 라벨 strip + 보고체("~다고 한다"$) 세그먼트 제거 | vitest 4케이스 |
| 한 문장 복수 가족 누락 | HIGH | "큰딸은 영숙이고 막내아들은 준호야"에서 막내아들 패턴이 은/는 조사 미지원 → 준호 미저장 → fact-checker가 이름 답변을 비근거로 제거(이름 질문에 회피 응답). 둘째/셋째/막내 패턴에 은/는 추가 | vitest 4케이스 + 라이브: 준호 저장·응답 확인 |

회귀 고정: `__tests__/cycle-regression-2026-06-10.test.ts` (vitest 총 69/69 · safety-regression 38/38 · tsc 0).

### 미해결 / 관찰
- [ ] 손주 간접 표현("손주 민준이가", "영숙이네 큰애") 추출 미지원 — FP 위험(손주 녀석 등) 검토 후 패턴 추가 필요.
- [ ] 단어 등록 직후 AI가 단어를 복창("'바다, 하늘, 나무' 잘 외우셨군요") — 리허설 효과로 지연회상 민감도 약화 가능. 프롬프트 한 줄 검토.
- [ ] e2e-dynamic.mjs 페르소나 발화가 중간 잘림 — 페르소나 생성기(2.5)에 thinkingConfig 미설정으로 thinking이 maxOutputTokens(256) 잠식. 테스트 도구 자체 품질 이슈(앱 무관).
- 분석기 2단 라우팅 recall은 이번 사이클 6/6이나, 표본 확대 위해 judgment-verify 110케이스 재실행 권장(COGNITIVE_TWO_STAGE=0과 1:1 비교).

---

## 2026-06-11 — 적대적 리뷰(14건) + 2단 라우팅 보정 + 100턴 사이클 (스크립트 50 + 실시간 50)

상세: docs/리포트_2026-06-10_100턴사이클.md (gitignore됨 — 로컬 보관).

### 적대적 리뷰 확정 14건 전부 수정
KO_REPORTIVE STT 발화 삭제(extractText isUserSpeech) / 음성 날짜단락 L1·L2 삼킴(모더레이션 뒤+응급 시 비단락, 텍스트 동일) / TITLE 조사·호격·개행 무력화(복합조사+호격패스) / "막내딸은 의사야" 술어 FP(stopword 28개) / 수다턴 회상 정답노출 공백(base 자립화+hint 예외) / 임상용어 금지 소실(base 확장) / escalation 실패 시 lite 폐기(폴백) / 폴백턴 분석 스킵(사용자 발화는 분석) / 스트림 중도실패 미완조각(문장 절단) / sttFailed 말풍선 잔존 / 꺼져·떡 FN 회귀 복원 / unmountedRef 3곳 / VERCEL.md SSL env / 마이페이지 8자

### 2단 라우팅 judgment 평가 (118케이스 1:1)
- OFF(단일 3.5): 114/118 · ON(v1): 112/118 → **probe '답변' 턴이 lite로 새는 구조 갭 발견**(중증 '섣달' 케이스)
- fix: 직전 AI 질문도 probe 판정 포함 + orientation_time 패턴 조사 허용 → **ON(v2): 113/118, 중증 41/41 복구**
- 잔여 −1(경증 "잠깐 헷갈렸네")은 문서화된 경계노이즈. 공통 미스 4건은 모델 무관 기존 클래스(language 동물 6~7개)

### 100턴 사이클 (수정 후 코드)
- 스크립트 50: 빈응답·누출·오탐 0 / 실시간 50: 이상 6/6 감지·오탐 0, fix 라이브 재검증 전부 통과(회상 비노출 "알려줘봐" 포함)
- 신규 fix 1: L1 수면 패턴 부사 삽입형("통 못 자") + "못 잔다" 활용 허용 (emergency.ts)
- 관찰 4(기록만): 가족 구성 잘못 복창 1회(생성 노이즈) / 31턴 전 등록 단어 "외운 적 없다" 단정·세션 초 정보 재질문(컨텍스트 20개 윈도우 한계) / "선희이세요" 조사
- 파이프라인 실측: analyzer lite:3.5 = 84~89% lite, thinking 0, cached ~3.9k/턴

### 검증
vitest 78/78 · safety-regression 38/38 · tsc 0 · prompt-leak 클린. test-emergency-detect.ts 34/36의 실패 2건은 L2 기존 실패(이번 변경 무관, 스크립트 노후 — vitest가 기준).

---

## 2026-06-11 (오후) — T1·T2 잔여 갭 반복 1라운드

### Fix 4건
| 항목 | 내용 | 검증 |
|---|---|---|
| 세션 중기 기억 (T2) | 서버가 DB에서 최근 80메시지 직접 로드(클라 slice 의존 제거) + 컨텍스트 창 24 + **창 밖 25~80번째 사용자 발화 압축 다이제스트 주입**. RAG 랭킹 운에 좌우되던 30~60메시지 전 회상 해소 | 라이브: 56메시지 전 "텃밭 공룡 농담→옆집 개" 정확 회상 (수정 전 동일 질문 실패 확인) |
| 음성 왕복 단축 (T2) | STT를 POST 초입에서 시작 — weather·프롬프트·이력 조회(~1.2s)와 병렬. 구조상 ~1-1.5s 단축 | 코드 검증 (음성 실측은 차기) |
| 선행 지연 (T1·T2) | buildSystemPrompt 5개 순차 쿼리 → 단일 Promise.all | DEBUG_TIMING 실측 promptMs **72ms** |
| C2 보호자 알림 (T1·T2) | lib/health/cognitive-alert.ts 신설 — 최근7일 vs 이전30일 추세(detectAcuteChange 재사용), 급성악화 또는 악화+중증 시 notifyGuardian, 72h 디바운스, **C2_NOTIFY=1 게이트(기본 off — 정책 결정 대기)** | tsc·단위 경로 검증 (웹훅 실발송은 보호자 설정 계정 필요) |

### 실측 (텍스트 턴)
weatherMs 1167(병렬블록 max — 임베딩/날씨 캐시미스) · promptMs 72 · 선행계 1.25s · 첫 문장 4.1s(LLM 생성 ~2.8s 지배). 스모크 10턴: 빈응답·누출 0.

### 미해결/다음
- 첫 문장 4.1s의 지배 요인은 LLM 생성(thinking 512 포함) — 단축하려면 thinking 추가 하향 A/B 또는 모델 전략 필요
- C2 알림 정책 결정 필요(발동 임계·문구·채널) → 결정 후 C2_NOTIFY=1
- T1 다환자 관리 — 설계안 제시(전문가-환자 연결 방식이 제품 결정): ExpertPatient 테이블 + 초대코드 연결 + /expert 환자목록 + 권한·감사로그

---

## 2026-06-11 (저녁) — T1·T2 반복 2~3라운드 (커밋·푸시 루프)

| 커밋 | 내용 | 검증 |
|---|---|---|
| a49b7d8 | T2 세션기억(DB 80+다이제스트) · STT∥프롬프트 병렬 · 쿼리 병렬(promptMs 72) · C2 알림 메커니즘 | 56메시지 전 회상 라이브 PASS, 스모크 10턴 클린 |
| 1882b89 | **T1 다환자 관리** — ExpertPatient+expertCode(수동 SQL), 초대코드 연결(환자 본인 동의), /expert 환자목록(등급·추세·이상건수), 열람=채점·요약만 | E2E: 코드발급→연결→403차단→박순자(경증·개선·17건) 표시 |
| 755512a | thinking 예산 env화 + A/B: 512→256 = 생성 30%↓(3.2~3.6s→2.3~2.4s), 품질 저하 미관찰 → 로컬 256 적용 | 2턴×2 실측 + 응답 육안 검수 |

### 운영 메모
- Vercel env 추가 권장: `COMPANION_THINKING_BUDGET=256` (+ C2 켤 때 `C2_NOTIFY=1`)
- 다음 정기 사이클 관찰 항목: ①256 예산 대화 품질 ②다이제스트 주입 부작용(앞부분 발화 과참조) ③C2 발동 임계 적정성

### 다음 후보 (우선순위)
1. T1 의사용 환자 상세 리포트(영역별 추세 그래프 + 근거 발화 — 열람 범위 정책 결정 필요)
2. T2 30턴 정기 사이클(256 예산 + 다이제스트 회귀 관찰)
3. T3 정신건강 척도 설계 착수(PHQ-9 대화형 변형)
4. ExpertPatient 연결 해제 UX(환자 측 revoke) + 조회 감사로그 테이블

---

## 2026-06-11 (밤) — 반복 D·E·F

| 커밋 | 내용 | 검증 |
|---|---|---|
| (사이클) | 30턴 정기 사이클 — 256 예산·다이제스트 회귀 관찰 | 빈응답 0·누출 0·후처리 빈문자열 0 (1건=페르소나 도구 잘림 재질문, 기지) |
| 9b398bf | **T1 환자 상세 리포트** — 영역별 7일/30일·8주 추이·이상 이벤트(분석기 임상 근거). 원문 비조회 | 라이브: 박순자 7영역 실데이터+근거 표시, 미연결 403 |
| (설계) | **T3 설계 v0.1** — docs/T3_정신건강_설계.md: PHQ-9 대화형 변형 9문항, 응답분류기(자기보고≠관찰 채점 구분), 9번 위기 플로우, mental_assessments 테이블 계획, 비진단 고지 원칙 | 문서 |

다음 구현: T3 mental-bank + 테이블 + scorer (설계 §5 순서)

---

## 2026-06-11 (심야) — 반복 G: T3 구현 1단계 (dbd0d50)

- **PHQ-9 대화형 검진 전 구간 작동**: 트리거→동의(설명 재질문 1회)→9문항(빈도 분류: 정규식 fast-path+모호만 LLM, 변형 재질문)→합산·컷오프 해석→본인용 /mental 결과
- 9번 자해사고 즉시 위기 안내 / 응답 원문 비보존 / route 배치: 응급 이후·모더레이션 이전(9번 답변 가로채임 방지)
- 라이브 E2E: 9문항 다양 표현 → 합계 8 「가벼운 수준」 정확(수기 계산 일치), DB 점수 9행
- 검증: vitest 103/103 · safety 38/38 · tsc 0

### 다음 후보
1. T3 2단계: GAD-7 추가 · 채팅 진입 버튼 · 음성 모드 지원 · 9번 양성 시 후속 케어 플로우
2. T2 음성 실측(STT 병렬 효과) · C2 정책 결정 대기
3. T1: 검사 이력 무결성 · ExpertPatient 연결 해제 UX · 감사로그 테이블

## 2026-06-11 (심야 2) — 반복 H·I (5ead630)

- **H (T3 보강)**: 과거 서술 오발동 가드("우울 검사 받았어" 미시작, 한글 \b 회피) · 글씨 모드 진입 버튼 · 음성 모드 검진 지원(audio 1.49단계)
- **I (T1 동의 철회)**: GET/DELETE /api/users/linked-experts + 마이페이지 연결 목록·해제 버튼. 해제 → DB revoked·전문가 목록 즉시 제외 → 재입력 시 재연결(upsert)
- E2E: 오발동 가드/버튼 시작/그만할래 중단/해제·재연결 전부 PASS. vitest 103/103 · safety 38/38

### 남은 후보: T3 GAD-7 · 9번 양성 후속 케어 / T2 음성 실측 / 감사로그 테이블 / C2 정책 결정

## 2026-06-11 (오전) — 반복 J·K: GAD-7 + 위기 후속 + 감사로그 (4890768)

- **J (T3 GAD-7)**: SCALES 레지스트리(PHQ9/GAD7)로 mental-flow 척도 일반화. "불안 체크" 트리거, 컷오프 5/10/15. PHQ9 완료 → GAD-7 교차 제안(crossLine). 9번 양성 시 careLine(위기 후속 초대) + mental_session.crisis 저장 + /mental 위기 배너(109/1577-0199)
- **K (T1 감사로그)**: expert_access_log 테이블 + patients list('*')/detail INSERT(실패 무시). restore-raw-tables 패리티 갱신
- 라이브 E2E: "불안 체크도 해볼래"→GAD-7 안내→7문항 진행→합계 3 「정상」 정확 · DB scale=GAD7 행 확인 · 전문가 로그인→list/detail 호출→감사 2행 적재
- 검증: vitest 106/106 (GAD-7 무결성·컷오프 +3) · safety 38/38 · tsc 0

### 남은 후보: T2 음성 실측 / 9번 양성 후속 케어 심화 / C2 정책 결정 / /expert 감사로그 노출

## 2026-06-11 (낮) — 반복 L·N·P: 사이클 마라톤 발견 결함 3건 (464ea3c·3262631·진행중)

- **L (464ea3c)**: 30턴 실시간 사이클 발견 2건 — ① 검진 동의 단계 대화 가로채기(딴 주제 발화 → 조용히 세션 접고 일반 대화 위임, CONSENT_TOPIC_RE) ② 동반자 이름 조사 후처리(fixFamiliarNameParticles: 지윤가→지윤이가, 받침 이름 + 한글 lookaround)
- **N (3262631)**: 보속증 안전망(동일 발화 3턴 연속 → memory_immediate 강제, LLM 채점 중복 방지) + postprocess 빈문자열 시 제거 원문 80자 로깅 + e2e 드라이버 페르소나 잘림 fix(maxTokens 1024 + 동일발화 재생성 폴백)
- **P**: ungrounded 필터 FP 해소 — 관측 로그로 추적한 진짜 원인 2개: ① 조사 차이("쌀이랑"↔ctx"쌀도") 부분일치 실패 → 꼬리 조사 longest-first 2단 스트리핑 후 어간 재대조 ② 동사 활용형("오신다고/하셨죠")이 명사로 추출돼 무조건 대조 실패 → VERBAL_TAIL_RE 제외. **전제 문장이 사실상 무조건 삭제되던 구조** (30턴 폴백률 10% 원인)
- 라이브: 분석기 채점 정확도 재확인(1985년=2, 정정수용=0, 보이스피싱 거절=정상) · 응급 119 즉시 · 위기 경로(careLine→crisis=true→/mental 배너) 전 구간
- 검증: vitest 110/110 · safety-regression 41/41 (보속증 3건 + ungrounded 2건 추가)

### 다음 후보: 음성 왕복 실측(measure-voice-latency.mjs) / 9번 양성 후속 케어 심화 / C2 정책 / /expert 감사로그 노출

## 2026-06-11 (오후) — 반복 Q·R·S·T: 폴백 0% 달성 + 음성 실측 + 프라이버시 투명성

- **Q (36d6941)**: ungrounded 대조 범위를 전제 절로 한정(단정형/관형형 marker 구분) + 의문형 회상("좋아하셨던 곡 있으세요?") 보존 + VERBAL_TAIL 게/죠
- **R (6e325da)**: fact-checker 死 정규식 2건 — 행정 접미사 시/구/동/읍/면이 존댓말 흡수("편하시군요"→"편하" 후보 5개 전원 미근거→wholesale 교체 오발동) → 처소격 직결 조건. 연결어미 "담가서"가 이름 후보("담가서 아드님들이")로 잡혀 문장 삭제 → 활용형 어미 후보 제외('은$'은 실명 지은/하은 보존)
- **재검증: 30턴 폴백 0건** (10%→0) · 빈응답 0 · 누출 0
- **S (44bec7c)**: 음성 왕복 실측 — 첫chunk 6.54s = STT 3.68s(56%) + LLM 첫문장 2.6s + 기타 0.4s. STT thinkingBudget 64 → 3.18s(−0.5s). flash-lite A/B 기각(어미 소실 "먹었어"→"먹고" — 전사는 인지분석 입력). sttMs 계측 추가, STT_MODEL env 레버
- **T (108c277)**: 내 기록 열람 내역 본인 공개(/api/users/access-log + 마이페이지 토글) — 전문가 열람의 환자측 투명성

### 남은 후보: C2 정책(사용자 결정 대기) / T1 검사 이력 무결성 / 스트리밍 STT(백로그) / @google/genai 마이그레이션

## 2026-06-11 (오후 2) — 반복 U: 빌드 검증 + 음성 검진 + 회상 노출 갭 (44bec7c~29ec033)

- **프로덕션 빌드 PASS** (next build, 신규 라우트 포함) — Vercel 배포 차단 요소 없음
- **음성 경로 검진 재검증**: TTS합성→음성경로로 "불안 체크"(STT "불안 체크해 볼래?") → GAD-7 시작/중단 JSON 정상
- **U (29ec033)**: 회상 정답 노출 갭 — "아까 외우라던 단어 물어봐줘"에 정답 3개 노출.
  stripRecallAnswerLeak 회상 컨텍스트에 과거 보고형(말씀드렸었죠/불러드렸)·생각나 누락 → 보강.
  등록(미래형) 보존 회귀 포함 safety 45/45
- 회상 게임·끝말잇기(사과→과자→'자' 요청 정확)·등록 단어 노출 보존 전부 PASS

### 남은 후보: C2 정책(사용자 결정 대기) / T1 검사 이력 무결성 / 스트리밍 STT / @google/genai 마이그레이션

## 2026-06-12 — SDK 마이그레이션: @google/generative-ai → @google/genai (7b4d0be)

- 프로덕션 6파일 전체 전환: llm.ts(싱글톤+구 SDK 모양 어댑터로 스트리밍 안전망 무변경), 분석기/요약기/추출기/검진채점기/STT는 ai.models.generateContent 직접 호출
- thinkingConfig 정식 지원 — `as any` 캐스트 전부 제거. extractText는 신·구 shape 병행(스크립트 호환)
- 부수 개선: companion usage 로그 model=?→실제 모델명 (스트림 modelVersion 전달)
- 검증 풀코스: tsc 0 · vitest 112/112 · safety 45/45 · 라이브 스모크(기억 연속성·probe 승급) · 30턴 사이클 클린 · 음성 실측 5/5 전사 정확(지연 동등 6.4s) · next build PASS
- a8c2ce1: generated prisma client 동기화(1882b89 미커밋분)
- 다음 단계(별도): explicit caching 활성화 — 시스템프롬프트+질문풀 캐시 객체 등록, 트래픽 본격화 시점에 저장료 대비 절감 실측 후 결정

## 2026-06-12 (저녁) — 3역할 × 50턴 유동형 검증 (e2e-roles.mjs 신설)

- 드라이버: 역할별 페르소나(어르신 김순자78 / 직장인 박지훈35 / 수검자 박영감81)가 AI 응답을 보고 실시간 발화 생성. 역할별 **모드 혼입 감지기** 내장(일반인←인지질문 / 사용자·전문가←정신건강 언급)
- **결과: 150턴 전수 클린** — 빈응답 0 · 누출 0 · 모드혼입 0 · 이상 0 (역할당 50턴)
- DB 검증: 일반인=검진 2건 완료(PHQ-9 16점 「다소 심한」+BFI-10 프로파일)·인지평가 0행 / 전문가=인지평가 19행·7영역 전체 / 사용자=인지평가 22행(80/20 페이스 일치)

## 2026-06-12 (오후) — 3역할 × 100턴 Playwright 실시간 운전 (Claude 직접)

발견·수정 7건 (전부 즉시 수정→회귀고정→라이브 재검증→커밋):
1. **모더레이션 死 정규식**: "동네야 동탄"→야동 / "처음부터"→음부 / 자위·성기 동급 — 한글 경계 가드 (2ea9f84)
2. **매 턴 호명 기계감**(사용자 피드백 2회): 기본 무호명 + 4~5턴 1회 — 프롬프트 단순화 + limitVocativeOpening(호격 구두점 필수 — 주어 '할머니는' 깎던 1차 부작용도 라이브에서 잡음) (2ea9f84·후속)
3. **성별 친족어**: 여성에게 "형이나 누나" — 질문풀 2건 중립화 + 성별 친족어 프롬프트 규칙 (45f0627)
4. **응급 갭**: 가슴 답답+식은땀(심근경색 조합)이 L0 → 조합 L3 격상, 단독은 비응급 유지 (e0b144e)
5. **부모 referent 혼동 재발**: "어머니가 해주시는"→"호칭께서 해주시는" — fixParentReferent 결정적 복원 (2025a96)
6. **따라하기 빈 따옴표**: 등록 단계 재요청이 회상으로 오인돼 단어 삭제 — isRegistration 보강
7. 관찰(미수정): 전문가 모드 첫 턴 다문항 일괄 출제(시간지남력 4개 — MMSE 묶음 시행 관행이라 보류), 지연회상 이중 평가 행(1점+0점 동시 기록 — 전문가에게 전체 맥락 제공이라 보류)

검증 PASS 전수: 기억 시드→회상 4/4(복실이54턴·채송화70턴·춘천67턴·두부65턴 간격, 전부 윈도우 밖) ·
회기간 기억(김씨 할머니 문병) · 분석기 채점(불가능거래2·속담0·2/3회상1·연속빼기0) · 모드혼입 0(3역할) ·
검진 채점(PHQ-9 11 중간·UCLA-3 8 높음 수기일치) · 표준검사 7영역 완주 · 응급 119 · 평균 지연 ~4s
수위: vitest 139/139 · safety 61/61

## 2026-06-12 (심야 2) — 전문가 검사 결과지 + 라이브 음성(베타) (3b3568f·d0e09cf)

- **검사 결과지(T1)**: /api/expert/session-report + /expert 섹션 — 일자별 7영역 카드(색 등급)·근거 펼침·종합 소견. E2E: "7/7 시행 — 주의 1건: 지연 기억(1점)" 정확
- **라이브 음성 베타(T2)**: /live — Gemini Live 직결(ephemeral token, API key 비노출). 첫 AI 응답 브라우저 실측 **1.05초**(기존 6.1초). 안전망 게이트(출력 전사 선행→검사→재생, 위반 시 턴 음소거), barge-in, 턴 회송(/api/live/turn: 저장+인지분석+응급 신호)
- 핵심 발견: **Constrained 연결은 클라 config 무시** — 전사 설정·페르소나를 토큰 발급 시 서버가 고정해야 함(전사 미수신 버그로 실증). CSP connect-src에 Gemini WS 추가(키는 비노출)
- runCognitiveAnalysis → lib/chat/cognitive-run.ts 추출(경로 공유, route 분리 백로그 일부)
- v1 제약: /live는 일반 대화 전용(검진·모더레이션 즉답 게이트 미지원 — 화면에 명시), 입력 전사 품질은 현행 STT 대비 거칢(인지분석 신뢰도 관찰 필요), 보이스가 Gemini 보이스
- 검증: tsc 0 · vitest 139 · safety 61 · next build PASS · fakemic E2E 풀체인(전사·응답·DB 저장)

## 2026-06-15 — 종합 마라톤 (Opus 4.8, 검증_플레이북 전 항목 A~F)

**범위**: 3역할 유동형 235턴(사용자 90·일반인 95·전문가 50) + 안전 스팟체크 7 + DB 그라운드트루스 3계정 + 보안경계 2.

### 발견·수정 (1건)
- **A-모더 死정규식 "음탕"이 "닭볶음탕"을 차단** 🔴→✅
  - **증상(사용자 90턴 라이브 재현)**: 어르신이 "닭볶음탕 맛있지"라 하자 AI가 "그런 말씀은 좀 그렇잖아요…하지 말아주세요"로 **2회 추궁**(외설 오인). 자동 감지기는 못 잡음(회피문구 정규식 불일치).
  - **root cause**: `lib/chat/moderation.ts` SEXUAL_EXPLICIT의 `/[음웅]\s*탕|[음웅]\s*란/` — 한글 경계 없어 "닭볶**음탕**"의 '음탕' 단어내부 매칭. (메모리 feedback_bughunt_dead_regex 동일 클래스 — 이 파일 19~34행 기존 fix와 같은 패턴)
  - **수정**: `(?<![가-힣])[음웅]\s*탕|(?<![가-힣])[음웅]\s*란` — 앞 한글이면 제외, 단어시작/공백 뒤("음탕한"·"음란물")만 매칭.
  - **회귀**: safety-regression에 닭볶음탕·오징어볶음탕 정상 + 음탕한/음란물 차단 4건 추가 → **65/65 PASS**.
  - **라이브 재검증**: 사용자 계정에 "닭볶음탕 해먹을까" 직접 송신 → "맛있겠어요" 정상 응답(차단 없음). [x] DONE

### 검증 PASS 전수
- **정적**: tsc 0 · vitest 139/139 · safety **65/65** · next build PASS
- **유동형 235턴**: 빈응답0·누출0·모드혼입0·기억실패0 (모더FP 1건 외 클린). 지연 사용자/일반인 p95 4.5s, 전문가 p95 19.9s(긴 검사응답 SSE — 서버 /api/chat은 ≤1.9s, 서버지연 아님)
- **기억 회상**(윈도우 밖): 복실60턴·채송화90턴(사용자), 춘천70턴·두부95턴(일반인) 4/4
- **인지 분석기 채점 정확도(★ DB 실측)**: 전문가 `memory_delayed avg1.00`(모자 탈락 포착)·`orientation_time 0.33`(연도 오답)인데 `attention_calculation 0.00`(연속뺄셈 전부 정답→무이상). 점수가 실제 수행과 정확 대응. 사용자(정상응답)=전영역 0.00
- **모드 분리 양방향**: 일반인=인지평가 0행·정신검진 2건(PHQ-9 **17점** 수기검산 일치·crisis=false / BFI-10) / 사용자·전문가=인지평가 7영역·정신검진 0 / 사용자 계정 "마음건강체크" → PHQ-9 미발동(공감만)
- **안전 경로**: 응급 L3(흉통+호흡곤란→즉시119·우회없음) · 회상 정답 비노출(직접 떠올리도록 유도) · 모더FP(화투·약주·닭볶음탕 정상)
- **보안(D)**: 전문가→비연결 환자 상세 **403** + 목록 연결1명만(비연결 id 미포함) · **mode 스푸핑 차단**(user 세션이 body.mode=general 보내도 세션역할로 무시→PHQ 미발동)

### 관찰 (미수정 — 보고만)
- [ ] **텍스트 전용 모드에서 TTS 발화**: `app/chat/page.tsx` sendMessage→streamAndSpeak가 `textOnly` 무시하고 항상 문장단위 `/api/tts` 호출 → 235턴 텍스트 e2e에서 **TTS 697회 + 429 폭주**. 제품/UX 결정(접근성 의도?)이라 임의 미수정. textOnly 시 TTS 생략/토글 검토 권장.
- [ ] **companion 프롬프트 캐시 `cached=0` 빈발**: 비용 절감 여지(기존 백로그 "프롬프트 캐시순서"와 동일). analyzer-lite는 캐시 양호(~5670).
- [ ] **공감/작별 루프 단조로움**: 일반인 후반 ~25턴, 전문가 검사종료 후 ~15턴이 동일 패턴 반복. 페르소나 구동기 루프 영향 큼(메타 "AI가 계속 인사" 출력) — 안전결함 아님.
- [ ] **Phase F 프로드 스모크 미실행**: 배포 사이트 실데이터 쓰기라 승인 후 별도 시행 권장.

## 2026-06-15 (2) — 일반인 집중 사이클 (4종 척도 58턴)

**범위**: 일반인 단일 역할 58턴, 정신건강 4종 척도 전부 라이브 (GAD-7·UCLA-3는 직전 마라톤 미시연 백로그였음).

### 발견·수정 (1건)
- **검진 중단 死정규식 "그만두면"이 BFI-10 오중단** 🔴→✅
  - **증상(라이브)**: 성격검사 8번 답변 "그런 편이에요. 중간에 **그만두면** 계속 신경 쓰여서요"(성실성 *서술*) → 검진 강제 중단("부담 갖지 마세요…"). DB: BFI10 status=aborted, item=8, 문항 7개만 채점, total=null. **2차 증상**: 중단 후 LLM이 가짜 성격 결과를 지어냄(미완료인데 결과 표시).
  - **root cause**: `lib/health/mental-flow.ts` ESCAPE_RE의 bare `두`가 "그만**두**면/그만두고"(연결어미 서술)에 매칭 → 중단 의사로 오인 (死정규식 클래스, 모더 닭볶음탕과 동형).
  - **수정**: `두(?!면|고|니)` · `관두(?!면|고|니)` 부정 lookahead. "그만둬/그만할래/그만하자/중단/취소"는 그대로 감지, "그만두면/그만두고/그만두니"(서술)는 제외. `isAbortIntent` 순수 predicate 노출(테스트용).
  - **회귀**: safety-regression #15 mental-escape 6건 추가 → **71/71 PASS**.
  - **라이브 재검증**: BFI-10 4번 답변에 "그만두면" 포함 송신 → 중단 없이 10문항 완주, 실제 결과(외향성 2/8·성실성 7/8…) 산출. **오중단=없음·완주=예** 확정. [x] DONE

- **TTS 검진 머리말 "1/10."을 "십분의 일"(분수)로 낭독** 🟡→✅
  - **증상(사용자 피드백)**: 검진 문항 머리말 `${no}/${total}`("1/10.")이 Cloud TTS에서 분수("십분의 일")로 읽혀 부자연스러움. 화면 표시 "1/10"은 문제 없음 — 낭독만 이슈.
  - **수정**: `sanitizeForTts`를 순수 모듈 `lib/chat/tts-text.ts`로 분리 + 머리말 시그니처("N/M." + 공백/끝)만 매칭해 "첫/두/…/열 번째 문제."로 변환(native 순서). 낭독 전용 — 화면 텍스트는 그대로. 일반 분수("하루 2/3 정도")는 미변환(FP 가드).
  - **회귀**: safety-regression #16 6건 → **77/77**. tsc 0. 라이브: /api/tts 200(리팩터 후 정상). [x] DONE

### 검증 PASS
- 4종 척도 DB 채점 정합: PHQ-9 total=16(수기일치)·GAD-7 21(심한)·UCLA-3 9(높음) 전부 done / 9번 crisis=false / cognitive_assessments 0행(모드분리)
- tsc 0 · safety 77/77 · 58턴 빈응답0·누출0·모드혼입0 · BFI-10 '그만두면' 라이브 재검증(보이는 브라우저, 5/10 진행·완주)

### 관찰 (미수정)
- [ ] **중단 후 LLM 결과 환각**: 검진이 중단/미완료 상태인데 사용자가 "결과 보여줘" 하면 동반자 LLM이 그럴듯한 가짜 척도 결과를 지어냄. 이번 FP 수정으로 해당 시나리오는 해소됐으나, 일반적 "미완료 검진 결과 요청" 방어(프롬프트/가드)는 별도 백로그.

### 마라톤 재검증 (fix 반영 후 전체 회귀)
- Phase A: tsc 0 · vitest 139 · safety **77/77** · next build PASS
- 3역할 235턴(사용자90·일반인95·전문가50) 전부 **이상감지 0** — 빈응답·누출·모드혼입·기억실패 0, 결함 클래스(오중단/모더FP) 문구 0
- DB 정합: 일반인 cognitive 0행 + PHQ-9 total=15(다소 심한)·BFI-10 / 사용자·전문가 mental 0 / 전문가 orientation_time avg1.60(연도 오답 정확 포착)·calc·recall ~0(정답)
- 기억 회상: 복실·채송화(사용자), 두부(일반인) — 전부 윈도우 밖 성공
- 2건 fix(ESCAPE·TTS) 회귀 없음 확인. 관찰(미수정): 텍스트모드 TTS 발화 잔존(전문가 429 1건), 검사종료 후 작별 루프(구동기 특성)

## 2026-06-15 (3) — 마라톤 재실행(headless) + 모드별 근거 보고서

3역할 235턴 재실행(사용자90·일반인95·전문가50). 신규 1건 발견·수정 + 1건 백로그.

### 발견·수정 (1건)
- **마크다운 볼드 `**`가 화면/DB에 노출** 🟡→✅
  - **증상(사용자 90턴 라이브)**: 동반자가 기억 단어를 "**수박, 양동이, 트럭**이에요"처럼 볼드로 감싸 별표가 화면에 그대로 표시(어르신에게 이상). TTS는 sanitizeForTts가 별표 제거하지만 표시·저장 텍스트엔 잔존.
  - **수정**: `lib/chat/postprocess.ts`에 `stripMarkdownEmphasis` 단계 추가(파이프라인 첫 단). `**볼드**`/`*이탤릭*`/`__볼드__`/잔여 별표 제거, 내용 보존.
  - **회귀**: `__tests__/postprocess.test.ts` 4건 추가 → **vitest 143/143**. tsc 0. [x] DONE

### 검증 PASS
- 235턴 재실행: 결함 클래스(오중단/모더FP/마크다운/빈응답) 문구 0(수정 반영 후). 일반인 PHQ-9 12(중간)·BFI-10 / cognitive 0행. 전문가 7영역·orientation_time avg1.00(연도오답 포착). 모드분리 양방향.

### 관찰 (미수정 — 백로그)
- [ ] **장기 기억 회상 간헐 실패**: 일반인 두부(고양이, 턴45 주입)를 턴95 회상에서 실패 + AI가 "고양이 안 키우신다고 하셨다"고 **부정 단언**(단순 '기억 안 남'보다 나쁨). 4회 마라톤 중 첫 발생(춘천·복실·채송화는 성공). RAG/요약 강화 + 미회상 시 부정 단언 금지(겸손 응답) 필요.
- [ ] HONORIFIC 감지기 오탐: 페르소나가 돌아가신 남편을 "할아버지"로 지칭한 정상 맥락을 e2e 감지기가 오탐(앱 결함 아님). 감지기에 남편/사망 맥락 예외 추가 검토.

### 산출물
- `docs/마음이음_검증결과_2026-06-13.pptx` — 모드별 검사·임상근거 보고서(10장). 인지 7영역(MMSE-K/MoCA-K/KDSQ-C/AD8/CDR) + 정신건강 4종(PHQ-9·GAD-7·UCLA-3·BFI-10 출처) 근거 표 추가. (리포트 — git 제외)

## 2026-06-16 — 치매군 작동성 강화: 기억 견고성 클러스터 (효돌 후기 분석 후속)

**배경**: 효돌(경쟁사) 실사용 후기 + 워크플로 화이트박스 감사(4영역+교차검증)로 "인지 저하 사용자 전제 안 한 설계" 갭 도출. IoT/센서 제외, 기억+과다발화부터 착수. 기억 클러스터 3건 구현·검증 완료.

### M1 🔴→✅ 반려동물·자전 사물 슬롯 미적재 → 회상 실패 구조적 보장
- **증상**: '고양이 두부'(턴45 주입)가 컨텍스트 윈도(24턴)·DB(80msg) 밖으로 밀려 턴95 회상 실패 — RAG 운에만 의존.
- **수정**: `profile-extractor.ts` `extractPetFromText`(종 확인 필수, 음식 '두부' FP 차단) → `user_fact(key='반려동물')` 저장. `renderProfileForPrompt`가 기존 facts 경로로 `[사용자 확정 정보]`에 상주 렌더 → **윈도 무관 항상 회상 가능**. LLM extractor 스키마에도 pet 추가. **마이그레이션 불필**(user_fact 재사용). 한글 음절 합성 주의("키워"≠"키우" 부분문자열 → 활용형 명시).

### M2 🟠→✅ 요약 keyFacts가 프롬프트에 0회 주입(구조화 사실 유실)
- **수정**: `summarizer.ts` `renderKeyFacts` 신설 → keyFacts(가족·고향·favorites·events 등)를 요약 뒤 '핵심 사실' 줄로 주입. 추가 LLM 비용 0(저장된 데이터 소비만).

### M3 🔴→✅ 거짓 부정 단언 가드 전무 (가스라이팅성 응답)
- **증상**: AI가 "고양이 안 키우신다고 하셨잖아요"로 사용자 확정 사실을 **반대로 단언**(인지 저하군에 가장 해로움).
- **수정**: `fact-checker.ts` `detectFalseNegationAgainstFacts` — 확정 사실(facts/family/profile)을 "안 한다/없다고 하셨다"고 단언하는 문장 제거. 확정 사실만 affirmed로 써 FP 최소화. **검증 소스 동기화**: grounding(isGrounded/isFamilyContextGrounded)에 `profile.facts` 포함 → 주입한 사실을 fact-checker가 도로 삭제하는 자기모순 방지.

### 검증
- tsc 0 · vitest **143/143** · safety-regression **87/87**(신규 #17 pet 5 · #18 거짓부정 3 · #19 keyFacts 2)
- 위 [ ] 백로그 '장기 기억 회상 간헐 실패 + 부정 단언' → 구조적 해소(라이브 50턴 재검증은 후속 권장)

### O1 🔴→✅ 과다 발화 제어 (engagement 다이얼) — '시끄러운 기계' 방지
- **증상(라이브 관찰)**: 단답·무성의 입력에도 매 턴 3~4문장+꼬리질문 → 공감·작별 멘트 십수 턴 반복(효돌 '혼자 떠듦'과 동일 클래스).
- **수정**: `lib/chat/engagement.ts` 신설 — `detectLowEngagement`(단답/맞장구/반복 → none·low·very-low) + `buildEngagementHint`. route.ts 음성·텍스트 핸들러의 정적 '질문하세요' 줄을 참여도 기반 hint로 교체(none=기존 문구 그대로, 동작 불변). very-low면 '한 문장 공감만·새 질문 자제·반복 금지'.
- **설계 긴장 해소**: 능동 재참여와 충돌 없이 — 침묵 강제 아님(한 문장 공감 유지), 질문 강요만 제거.
- **검증**: safety #20 6건 → safety **93/93** · tsc 0 · vitest 143. **라이브 스모크 PASS**: 단답('응/그래/몰라')→응답 26~44자 1문장·꼬리질문 0, 정상 턴은 평소대로. + pet 회상('나비')·거짓부정 없음 동시 확인.

### A1 🔴→✅ 적응형 난이도 폐루프 — 측정한 인지 등급을 대화로 환류
- **증상**: cognitive_assessments 채점·severity 등급이 보호자알림·전문가대시보드·요약에만 쓰이고 **라이브 프롬프트엔 0회 환류**(severity.ts를 prompt/route가 import조차 안 함). 중증도 정상군과 같은 200자·표준 난이도 → 따라오기 버거움.
- **수정**: `lib/health/cognitive-level.ts` 신설 — `getCognitiveTierForPrompt`(fetchDomainStats+severity 재사용, 최근30일) + `buildCognitiveAdaptationHint`. `buildSystemPrompt` 상단 Promise.all 배치에 tier 조회 1개 추가(추가 RTT 0, 사용자 모드 전용·pro/general 미적용·비용절감), guideBlock 뒤에 적응 블록 주입. **중증=1~2문장·쉬운 어휘, 고위험=한 문장·예/아니오**. 정상/경증/평가전=빈 문자열(현행 동작·프롬프트 캐시 보존). **응급·안전 안내는 길이단축 예외**(안전 hint 충돌 가드).
- **검증**: tsc 0 · vitest 143 · safety **99/99**(#21 6건). 라이브(중증 시드 계정 30턴)는 후속 권장.

### 추가 후속 (백로그 처리, 2026-06-16)
- **검진 결과 환각 방어** 🔴→✅ — 검진 미완료 상태에서 "점수 어때/결과 보여줘"에 LLM이 가짜 결과를 지어내던 문제. `mental-flow` no-session 분기에 `RESULT_REQUEST_RE` 가드: 완료 세션 있으면 "마음 건강 페이지에서 본인만" 안내, 없으면 "아직 안 하셨어요"(점수 비노출). general 전용. (a73d253, safety #22)
- **HONORIFIC 감지기 오탐** ✅ — e2e 하네스가 어르신의 배우자 지칭("돌아가신 할아버지")을 오호칭으로 잡던 FP에 `SPOUSE_CTX` 예외 추가 + 회상검증 시드(복실·채송화·춘천·두부). 앱 코드 무관. (8377be6)
- **텍스트 모드 TTS 게이팅(비용)** ✅ — '글씨로 대화'(textOnly)인데도 매 응답마다 문장단위 `/api/tts` 호출(턴당 수회·429 주원인). `speak()`/`speakStream()` 진입부에서 `textOnlyRef`로 중앙 게이팅 — textOnly면 음성 생략(메시지는 onReady/upsert로 렌더, 턴락 없음). 음성 모드는 무영향. **라이브 스모크 PASS**: textOnly 인사·응답 /api/tts 호출 0, 메시지 정상 렌더. (제품 결정: textOnly=무음)
- **probe 약점 영역 우선** ✅ — 적응형 난이도 후속. `getWeakDomainsForPrompt`(최근30일 영역평균 ≥ 위험임계)로 약점 영역을 probe 턴에만 조회(비용 최소), `remaining` 안에서 약점 영역 우선 선택. '오늘 확인한 영역'은 remaining에서 빠져 같은날 과다 재확인 없음. tsc 0 · safety 104/104.

### 능동 재참여(re-engage) 🔴→✅ — 세션 중 침묵 시 동반자 선발화 (2026-06-17)
- **구현**: 음성 세션에서 20초 침묵하면 idle 타이머 → `triggerReEngage` → `/api/chat {isReEngage, reEngageAttempt}` → `speak()`로 재생. speak() 경로를 그대로 타서 turnLock·600ms echo지연·speakGen·재청취를 상속. 서버 `handleReEngageGreeting`(attempt 1=주제 가볍게 재유도 / 2=후퇴, **2문장 하드캡**, 폴백 조사오류 회피). **2회 상한**, 발화 감지 시 리셋, textOnly/turnLock/세션비활성 시 미발동.
- **이해→구현→적대리뷰 워크플로**: 통합지점 매핑(4각) 후 구현, 적대적 리뷰(3각) 결함 검출 → 4건 보강:
  - F1 reEngageCount 새 대화(useEffect)·세션 시작(onWake)·종료 리셋 — stale count 영구차단 방지(high)
  - F2 idle 타이머 정리를 startRecording/speak/speakStream **진입부 일괄** — turnLock 폴링·재청취 누수/중복 근본 차단(critical)
  - F3 re-engage TTS 중 `aiSpeaking=true` — 자기 TTS의 '마음' wake 재발동 방지(high)
  - F4 validation `max(2)` 설계 일치
  - (리뷰 과대주장 제외: 기존 turnLock 가드가 '사용자 발화 중 fetch' race에서 사용자 발화 보존 / no-barge-in은 기존 설계 / 서버카운터는 rate-limit으로 충분)
- **검증**: tsc 0 · safety 104/104 · **서버 라이브 스모크 PASS**(attempt 1·2 짧은 nudge 생성). ⚠ **음성 idle 타이밍 실기기 검증은 후속**(headless 불가).

### 남은 작업(별도 진행)
- [ ] probe **빈도** 가변(등급별 간격) — 약점영역 우선은 완료.
- [ ] 음성 idle 재참여 실기기 검증(20초 침묵 → nudge → 재청취 echo 무발동 육안 확인).
- [ ] probe **빈도** 가변(등급별 probe 간격 조절) — 약점 영역 우선은 완료, 빈도 조절은 미착수(선택적).

## 2026-06-17 — 서비스레디 캠페인 (6축 종합 감사 → 배치 수정, IoT/119/알림 제외)

워크플로 6축 감사(보안·신뢰성·보호자화면·UX·비용성능·핵심정확성, 약 50건)를 우선순위 5배치로 수정.

### B1 보안·신뢰성 quick wins ✅
- **인지채점 점수 손실** — `saveCognitiveAssessments` ON CONFLICT (id) DO NOTHING → **DO UPDATE**. 같은 메시지 재분석 시 정정 점수가 버려져 등급 과소평가되던 문제.
- **임베딩 실패 silent-catch** — `saveMessageEmbedding().catch(()=>{})` → `console.warn`. message↔vector 불일치 은폐 제거.
- **인지분석 파싱 실패 silent** — `cognitive-analyzer` parseResult catch에 로깅 추가(평가 손실 가시화).
- **DEBUG_INPUT PII 로깅** — 2곳 모두 `&& NODE_ENV !== "production"` 가드(프로덕션 PII stdout 노출 차단).
- **conversationId 소유권 검증** — 타 사용자 대화 ID로 이력 열람·주입 차단(명시적 authz, findFirst {id,userId}).
- (멘탈세션 만료 KST: 검증 결과 `now()` vs `now()` 비교라 타임존 무관 — **오탐, 미수정**)
- 검증: tsc 0 · safety 104/104.

### B2 핵심 정확성 ✅ (검증 후 수정 — 오탐 다수 배제)
- **멘탈검진 발화 RAG 오염** — 정신건강 정형 답변("그런 편이에요" 등)이 사용자 RAG에 임베딩돼 일상 대화 회상에 noise. `saveMessages`에 `skipUserEmbedding` 추가, 멘탈 저장 2곳(음성·텍스트)에 적용.
- **오탐으로 배제(코드 검증)**: BFI-10 역채점(`maxScore-rawScore`는 표준 역문항 공식, 1회만 적용 — 정상) / moderation '자위' 문장끝(`(?![가-힣])` 분기가 이미 처리 — 정상).
- **위험·투기성으로 보류**: fact-checker FACT_NOUN 한글경계(死 정규식 영역, 라이브 미관찰 FP — 실데이터로 검증 후 결정). 응급 L1→L2 카운트(현 `recent+1` 로직 검토상 정상으로 보임).
- 검증: tsc 0 · safety 104/104.

### B3 보호자 화면(건강기록) 발전 ✅ — 사용자 명시 우선순위
- **복약 일정 카드 신설** — 대시보드에 복약 정보가 전혀 없던 갭. `/api/medications` 조회 → 약 이름·시간(뱃지)·알림 on/off 표시. ("약 먹는 시간을 잘 보이게" 요청 반영)
- **인지 추세 카드** — `/api/health-logs`에 `trend` 추가(최근7일 vs 이전30일, severity `detectAcuteChange` 재사용). ▲악화/▼개선/=비슷 + Δ수치 + 안내문. 기존엔 14일 비율만 있고 "변화 방향"이 없었음.
- **로딩/에러 상태** — health-logs 실패를 silent 무시(빈화면)하던 것 → 에러 UI + 다시시도 버튼. 로딩 문구 가독성 상향.
- **잠정 등급** — 5회+2영역이면 '판정 보류' 대신 'CDR n (잠정·참고용)' 조기 표시(보호자 대기시간 단축).
- **접근성** — 색약 대비 점수 기호(✓/⚠/✗) 병기, 본문 텍스트 대비 상향(zinc-600→700).
- **라이브 스모크 PASS**: 대시보드 무에러 렌더, 추세 카드 표시, 약 등록 시 복약 카드·이름·시간 표시 확인. tsc 0.

### B4 어르신 UX — 안전 항목 ✅ (광범위 시각변경·VAD 트레이드오프는 별도)
- **비밀번호 6↔8 불일치** — 클라 `minLength=6`인데 서버는 8자 요구 → 6~7자 제출이 서버에서 거부되던 버그. 클라 `minLength=8` + placeholder "비밀번호 (8자 이상)".
- **mypage 무한 로딩('먹통')** — 프로필 로드 실패 시 `error`는 set되지만 `!profile` 가드가 로딩 화면으로 가려 영원히 "불러오는 중". 가드 분리 → 실패 시 에러 메시지 + 다시시도/대화로 버튼.
- 검증: tsc 0.
- **별도 진행 권장(미적용)**: VAD 침묵 1s→1.5s(응답 지연 ↔ 어르신 끊김 트레이드오프, 제품 결정), 로그인/가입/채팅 폰트·대비·터치타깃 광범위 개선(헤드리스 시각검증 불가 — 육안 리뷰 필요).

### B5 비용·성능 — 측정 선행 필요(미착수)
- **실측 완료(2026-06-17)**: 같은 대화 3턴 companion usage 로그 = `input=16026/12240/12197, cached=0` 전부. **암묵적 프롬프트 캐시 미작동 확정** — 매 턴 12~16k 토큰 전액 재처리(probe 턴은 인지 프로토콜 ~3-4k 추가로 16k). 비용 영향 큼.
- **원인 추정**: guideBlock이 매 턴 변동(chitchat 랜덤 샘플·probe 조건부 protocol)이라 안정 프리픽스 뒤가 매번 달라짐 + 2.5-flash 암묵 캐시 미히트.
- **해법은 명시적 context 캐싱(SDK cachedContent)** — 안정 프리픽스(base+user+profile+summary)를 단기 TTL로 캐시. 단 TTL·무효화(profile/summary 변경 시)·계정별 캐시키·저장비용 설계 필요 → **"안전한 quick fix" 아님, 전용 작업으로 분리 권고**(추측 변경 금지).
- 인지분석 온디맨드/경량화는 품질·정확성 영향이라 라이브 검증 동반 필요. RAG 임베딩 캐시는 쿼리 고유성 높아 ROI 낮음(보류).
