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
