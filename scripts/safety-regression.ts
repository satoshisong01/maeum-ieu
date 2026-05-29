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
import { stripRecallAnswerLeak } from "../lib/chat/korean-particle";
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

console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
