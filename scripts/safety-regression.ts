/**
 * 안전망 회귀 테스트 — 라이브 사이클에서 발견·수정한 결함이 재발하지 않는지 결정적으로 검증.
 *
 * 사용: npx tsx scripts/safety-regression.ts
 * CI/PR 전, 또는 lib/chat 안전망 코드 수정 후 실행 권장. exit code 0=PASS, 1=FAIL.
 *
 * 커버 (docs/CYCLE_FIXLOG.md 참조):
 *   - A-1: grounding wholesale fallback 게이트 (단일 노이즈 명사로 정상 응답 nuke 금지)
 *   - A-2: 회상 정답 strip 후 비문("단어 세 개는 .") 방지
 *   - A-4: 자살 ideation 활용형("사라져버리고 싶어") L3 감지 + 정상문 오탐 방지
 */
import "dotenv/config";
import { factCheckResponse } from "../lib/chat/fact-checker";
import { stripRecallAnswerLeak, normalizeImnida } from "../lib/chat/korean-particle";
import { detectEmergency } from "../lib/chat/emergency";
import { salvageJsonLeak } from "../lib/chat/sanitize";
import { cleanName } from "../lib/chat/profile-extractor";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── A-1: grounding wholesale fallback 게이트 ──────────────────────────────
console.log("\n[A-1] grounding wholesale fallback gate");
{
  const emptyProfile: any = { family: [], profile: null };
  const fc = (aiText: string, currentUserText: string) =>
    factCheckResponse({ aiText, profile: emptyProfile, recentUserText: "", memories: "", honorific: "선생님", currentUserText });

  // 단어게임/지식답변/단일 노이즈 명사 → clobber 금지
  const r1 = fc("선생님, 민지가 단어 세 개를 말씀드릴게요. 하늘, 책상, 의자예요. 이따 다시 여쭤볼게요!", "단어 외우기 해볼래");
  check("word-game not clobbered", r1.cleaned.includes("하늘") || !r1.cleaned.includes("다시 한 번 여쭤볼게요"));

  const r2 = fc("선생님, 오늘 점심에 칼국수를 드셨군요! 따뜻하게 한 그릇 드시니 속이 든든하셨겠어요. 오후에는 동네 한 바퀴 산책이라도 하시면 기분이 한결 좋아지실 것 같아요. 혹시 요즘 즐겨 보시는 프로그램 있으세요?", "오늘 점심에 칼국수 먹었어");
  check("single-noisy-noun not clobbered", !r2.cleaned.includes("다시 한 번 여쭤볼게요"));

  // 밀집 환각 이름 다수 → 정밀 제거로 정리 (원문 그대로 노출 금지)
  const r3 = fc("선생님, 민수이가 영희이는 철수이도 다 잘 지낸다고 하더라고요. 그리고 순자이가 어제 댁에 왔다 갔다고 들었어요. 다들 건강하셔서 정말 다행이에요. 오랜만에 좋은 소식 들으니 민지도 기쁘네요!", "그냥 인사하러 왔어");
  check("dense-ungrounded names removed", !r3.cleaned.includes("민수이가") && !r3.cleaned.includes("순자이가"));
}

// ── A-2: 회상 정답 strip 비문 방지 ────────────────────────────────────────
console.log("\n[A-2] recall answer strip — no broken fragment");
{
  const broken = (s: string) => /세 개는?\s*[.!?]|세 개는\s*$|는\s+\.|예요\s*\.\s*$/.test(s);
  const c1 = stripRecallAnswerLeak("선생님, 아까 외워드린 단어 세 개는 나무, 자동차, 모자입니다. 기억나세요?");
  check("입니다 case clean", !broken(c1) && !c1.includes("나무"), c1);
  const c2 = stripRecallAnswerLeak("외워드린 단어 세 개는 '나무', '자동차', '모자'예요. 맞혀보세요!");
  check("quoted 예요 case clean", !broken(c2) && !c2.includes("자동차"), c2);
  // 정상 대화 오제거 금지
  const c3 = stripRecallAnswerLeak("좋아하시는 과일은 사과, 배, 포도 맞으시죠?");
  check("normal fruit list untouched", c3.includes("사과") && c3.includes("포도"), c3);
  // 카운터 콤마형 — "세 개, A, B, C였는데" (이전엔 '개,나무,자동차'를 잘못 잡아 '모자' 누출 + '세 ' 비문)
  const c4 = stripRecallAnswerLeak("아까 외워드린 단어 세 개, 나무, 자동차, 모자였는데 기억나세요?");
  check("counter-comma 정답 누출 없음", !c4.includes("나무") && !c4.includes("자동차") && !c4.includes("모자"), c4);
  check("counter-comma '세 ' 비문 없음", !/세\s+,/.test(c4) && c4.includes("세 개"), c4);
}

// ── A-4: 자살 ideation 활용형 ─────────────────────────────────────────────
console.log("\n[A-4] suicidal ideation conjugation coverage");
{
  const isSuicidal = (t: string) => { const r = detectEmergency(t); return r.category === "suicidal" && r.level === 3; };
  for (const t of ["다 부질없다 그냥 조용히 사라져버리고 싶어", "그냥 사라지고 싶어", "사라져 버리고 싶다", "이제 그만 사라지면 좋겠어", "그냥 다 끝내버리고 싶어", "이제 정말 죽고 싶어"])
    check(`L3 detect: ${t}`, isSuicidal(t));
  for (const t of ["안개가 걷히니 구름이 사라졌어", "통증이 사라져서 살 것 같아", "고민이 사라졌으면 좋겠네"])
    check(`no false positive: ${t}`, !isSuicidal(t));
}

// ── A-3: JSON 누출 방어 ───────────────────────────────────────────────────
console.log("\n[A-3] JSON leak salvage");
{
  const j1 = salvageJsonLeak('{"text": "할아버지, 오늘 날씨가 참 좋네요!", "isAnomaly": true, "analysisNote": "..."}');
  check("full JSON → text field extracted", j1 === "할아버지, 오늘 날씨가 참 좋네요!", j1);
  const j2 = salvageJsonLeak('{"text": "민지가 함께 있어요", "isAnomaly": tr');  // truncated
  check("truncated JSON → text recovered", j2 === "민지가 함께 있어요", j2);
  const j3 = salvageJsonLeak('```json\n{"response": "네, 선생님!"}\n```');
  check("fenced JSON → field extracted", j3 === "네, 선생님!", j3);
  const j4 = salvageJsonLeak("선생님, 오늘 점심은 드셨어요?");  // 일반 텍스트
  check("plain text untouched", j4 === "선생님, 오늘 점심은 드셨어요?", j4);
  const j5 = salvageJsonLeak('{"isAnomaly": true, "score": 2}');  // 텍스트 필드 없는 JSON
  check("JSON w/o text field → blanked (fallback)", j5 === "", JSON.stringify(j5));
}

// ── 민호라: 추출기 cleanName 인용어미 보정 ─────────────────────────────────
console.log("\n[extractor] cleanName quotative 라고 fix");
{
  check('"민호라"(민호라고) → 민호', cleanName("민호라") === "민호", cleanName("민호라"));
  check('"보라라"(보라라고) → 보라', cleanName("보라라") === "보라", cleanName("보라라"));
  // 2글자 라-이름 보호
  check('"보라"(보라야) 보존', cleanName("보라") === "보라", cleanName("보라"));
  check('"세라" 보존', cleanName("세라") === "세라", cleanName("세라"));
  check('"미라" 보존', cleanName("미라") === "미라", cleanName("미라"));
  // 기존 조사 제거 정상
  check('"영민이고" → 영민', cleanName("영민이고") === "영민", cleanName("영민이고"));
}

// ── A-6: fact-check fallback이 커스텀 동반자 이름을 사용(하드코딩 "민지" 누출 방지) ──
// 2026-06-01 적응형 라이브에서 발견: 동반자 "지윤" 계정인데 grounding fallback이 "민지가 …"로
// 엉뚱한 이름을 노출. fallback 멘트가 input.companionName을 따라야 함.
console.log("\n[A-6] fact-check fallback uses custom companion name (no hardcoded 민지)");
{
  const emptyProfile: any = { family: [], profile: null };
  // 단일 ungrounded 이름 문장 → strip 후 <20자 → fallback 발동. recentUserText가 가족/이름 질문.
  const r = factCheckResponse({
    aiText: "준호 아드님이세요!", profile: emptyProfile, recentUserText: "막내아들 이름이 뭐였지",
    memories: "", honorific: "할머니", companionName: "지윤", currentUserText: "막내아들 이름이 뭐였지",
  });
  check("fallback에 커스텀 이름 '지윤이가' 포함", r.cleaned.includes("지윤이가"), r.cleaned);
  check("fallback에 하드코딩 '민지' 미포함", !r.cleaned.includes("민지"), r.cleaned);
  // companionName 미지정 시 기존 기본값 "민지가" 유지(하위호환)
  const rDefault = factCheckResponse({
    aiText: "준호 아드님이세요!", profile: emptyProfile, recentUserText: "막내아들 이름이 뭐였지",
    memories: "", honorific: "할머니", currentUserText: "막내아들 이름이 뭐였지",
  });
  check("companionName 미지정 시 기본 '민지가' 유지", rDefault.cleaned.includes("민지가"), rDefault.cleaned);

  // 핵심: 동반자 자기 이름은 ungrounded로 strip 금지(응답 공백화 방지).
  // 2026-06-01 라이브: 커스텀 "지윤" 자기지칭 문장이 통째 삭제→빈 응답 저장됨.
  const rSelf = factCheckResponse({
    aiText: "할머니, 계산이 조금 잘못된 것 같아요. 지윤이도 같이 다시 세어볼게요!",
    profile: emptyProfile, recentUserText: "콩나물 샀는데 거스름돈", memories: "",
    honorific: "할머니", companionName: "지윤", currentUserText: "콩나물 삼천원어치 샀는데 거스름돈 이만원 받았어",
  });
  check("동반자 자기이름 '지윤' 문장 보존(삭제 금지)", rSelf.cleaned.includes("지윤") && rSelf.cleaned.length > 20, rSelf.cleaned);
}

// ── #7: normalizeImnida 받침없는 이름 '이에요'→'예요' (이전 \b 앵커로 항상 무동작이던 死 로직) ──
console.log("\n[normalizeImnida] 받침없는 이름 '이에요'→'예요' (이전 \\b로 死)");
{
  check("'수지이에요' → '수지예요'", normalizeImnida("수지이에요") === "수지예요", normalizeImnida("수지이에요"));
  check("'저는 민지이에요!' → '민지예요'", normalizeImnida("저는 민지이에요!") === "저는 민지예요!", normalizeImnida("저는 민지이에요!"));
  check("'영희이에요.' → '영희예요.'", normalizeImnida("영희이에요.") === "영희예요.", normalizeImnida("영희이에요."));
  // 받침 있는 이름은 '이에요' 유지(회귀 금지)
  check("받침이름 '수진이에요' 유지", normalizeImnida("수진이에요") === "수진이에요", normalizeImnida("수진이에요"));
}

// ── #11: 가족 순서 모순 검출 부활 (아드님/따님 존칭 형태 + order 없을 때 오매칭 금지) ──
console.log("\n[relation-contradiction] 가족 순서 모순 검출 (아드님 존칭)");
{
  const prof: any = { family: [{ name: "영수", relation: "son", orderIdx: 2 }], profile: null };
  const fcWarn = (aiText: string) =>
    factCheckResponse({ aiText, profile: prof, recentUserText: "", memories: "", honorific: "할머니", currentUserText: "" }).warnings;
  // 영수는 둘째인데 "큰 아드님 영수" → 모순 경고 발생(존칭 형태에서도 검출돼야 함)
  const w1 = fcWarn("큰 아드님 영수가 오셨다니 반갑네요");
  check("아드님 순서모순 검출", w1.some((w) => w.includes("relation_mismatch:영수")), JSON.stringify(w1));
  // 순서 표현 없으면 오매칭 금지 ("그 아들 철수가" → relation_mismatch 없음)
  const w2 = fcWarn("그 아들 철수가 잘 지낸다니 다행이에요");
  check("순서표현 없으면 모순경고 없음", !w2.some((w) => w.startsWith("relation_mismatch")), JSON.stringify(w2));
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
