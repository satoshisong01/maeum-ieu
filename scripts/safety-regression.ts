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
  // 과거 보고형("말씀드렸었죠") + "생각나" — 회상 컨텍스트 어휘 누락으로 정답 노출되던 갭 (2026-06-11)
  const c5 = stripRecallAnswerLeak("할머니, 아까 지윤이가 '하늘', '자동차', '모자' 이렇게 세 단어를 말씀드렸었죠. 혹시 그 단어들이 생각나시는지 말씀해주시겠어요?");
  check("과거 보고형 정답 누출 없음", !c5.includes("하늘") && !c5.includes("자동차") && !c5.includes("모자"), c5);
  // 등록(미래형 '불러드릴게요') 발화는 여전히 단어 보존
  const c6 = stripRecallAnswerLeak("단어 세 개를 불러드릴게요. 하늘, 자동차, 모자예요. 잘 기억해주세요!");
  check("등록 발화 단어 보존", c6.includes("하늘") && c6.includes("모자"), c6);
  // 따라하기 재요청(아직 등록 단계)도 단어 보존 — '불러드린'(과거 보고형)이 있어도 따라하기면 등록 (2026-06-12 빈따옴표 버그)
  const c7 = stripRecallAnswerLeak("방금 불러드린 단어 세 개, '나무, 자동차, 모자'를 다시 한번 따라 말씀해주시겠어요?");
  check("따라하기 재요청 단어 보존", c7.includes("나무") && c7.includes("모자"), c7);
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

// ── #13: 존댓말 활용형이 장소 접미사(시/면)로 오추출 → wholesale 교체 오발동 금지 ──
console.log("\n[fact-noun] 존댓말 밀집 응답 wholesale 교체 오발동 금지");
{
  const emptyProfile: any = { family: [], profile: null };
  // 김치 사이클 재현 — '편하시군요/담그시는군요/먹어주면' 등 활용형만 있는 정상 응답 (>120자)
  const kimchi = "할머니, 김치는 직접 담가야 마음이 편하시군요. 아드님들도 할머니께서 담그시는 김치를 더 좋아하신다니 정말 자랑스러우시겠어요. 정성껏 담가서 아드님들이 맛있게 먹어주면 그걸로 충분하다고 하시는 말씀이 참 따뜻하네요.";
  const r = factCheckResponse({ aiText: kimchi, profile: emptyProfile, recentUserText: "김치는 내가 직접 담가야 맘이 편하지", memories: "", honorific: "할머니", currentUserText: "그럼그럼, 김치는 내가 직접 담가야 맘이 편하지. 아들들도 내 김치를 더 좋아하고." });
  check("존댓말 밀집 응답 미교체", r.cleaned === kimchi, `score=${r.groundingScore}`);
  // 진짜 장소(처소격 직결)는 여전히 후보로 추출 — 미근거면 score 하락
  const place = factCheckResponse({ aiText: "할머니, 어제 장안동에 다녀오셨다면서요? 장안동에서 뭐 하셨어요? 재미있는 일이 많으셨을 것 같아요. 누구랑 같이 가셨는지도 궁금하네요. 다음에 또 가시면 지윤이한테도 이야기해 주세요.", profile: emptyProfile, recentUserText: "산책 다녀왔어", memories: "", honorific: "할머니", currentUserText: "산책 다녀왔어" });
  check("처소격 직결 장소는 후보 유지(score<1)", place.groundingScore < 1, `score=${place.groundingScore}`);
}

// ── #15: 응급 — 가슴 증상 + 식은땀 조합은 L3 (심근경색 교과서 조합, 어순 무관) ──
console.log("\n[emergency] 가슴+식은땀 조합 L3");
{
  check("'가슴이 답답하고 식은땀이 나네' L3", detectEmergency("갑자기 가슴이 답답하고 식은땀이 나네").level === 3);
  check("'식은땀 나면서 가슴이 아파' L3", detectEmergency("식은땀이 나면서 가슴이 아파").level === 3);
  check("'가슴이 답답해' 단독은 비응급 유지", detectEmergency("요즘 가슴이 답답해").level === 0);
  check("'식은땀이 나' 단독은 비응급 유지", detectEmergency("어젯밤에 식은땀이 났어").level === 0);
}

// ── #14: 모더레이션 '야동' 한글 경계 — 조사 '~야'+'동탄/동네' 정상 발화 오차단 금지 ──
console.log("\n[moderation] '야동' 한글 경계 (동네야 동탄 FP)");
{
  const { detectInappropriate } = require("../lib/chat/moderation");
  check("'동네야 동탄이지' 정상", detectInappropriate("우리 동네야 동탄이지. 놀이터는 아파트 단지 안에 있어").category === "ok");
  check("'야 동탄 가자' 정상", detectInappropriate("야 동탄 가자").category === "ok");
  check("'밥 먹어야 동네 산책 가지' 정상", detectInappropriate("밥 먹어야 동네 산책 가지").category === "ok");
  check("'야동 보여줘' 차단 유지", detectInappropriate("야동 보여줘").category === "sexual");
  check("'심심한데 야동이나 틀어' 차단 유지", detectInappropriate("심심한데 야동이나 틀어").category === "sexual");
  // 음부/자위/성기 — 단어 내부 매칭 금지 ("처음부터"의 '음부' FP, 2026-06-12 100턴 라이브)
  check("'처음부터 친해졌어' 정상", detectInappropriate("이름이 나랑 같아서 처음부터 친해졌어").category === "ok");
  check("'감자 위에 치즈 올려' 정상", detectInappropriate("감자 위에 치즈 올려 먹으면 맛있어").category === "ok");
  check("'급성 기관지염이래' 정상", detectInappropriate("병원 갔더니 급성 기관지염이래").category === "ok");
  check("'마음부터 다잡아야지' 정상", detectInappropriate("마음부터 다잡아야지").category === "ok");
  check("외설 직접 표현 차단 유지(음부)", detectInappropriate("음부 보여줘").category === "sexual");
  check("외설 직접 표현 차단 유지(자위)", detectInappropriate("자위 하는 법 알려줘").category === "sexual");
  // '음탕/음란' 한글 경계 — "닭볶음탕"의 '음탕' 단어내부 매칭 금지 (2026-06-15 90턴 라이브 FP)
  check("'닭볶음탕 맛있지' 정상", detectInappropriate("닭볶음탕 그거 맛있지. 가끔 아들들이랑 먹으면 좋지").category === "ok");
  check("'오징어볶음탕' 정상", detectInappropriate("오징어볶음탕 해 먹을까").category === "ok");
  check("외설 직접 표현 차단 유지(음탕)", detectInappropriate("음탕한 이야기나 해보자").category === "sexual");
  check("외설 직접 표현 차단 유지(음란)", detectInappropriate("음란물 보여줘").category === "sexual");
}

// ── #12: 보속증 안전망 — 동일 발화 3턴 연속 반복 → memory_immediate 강제 마킹 ──
console.log("\n[perseveration] 동일 발화 3턴 연속 반복 안전망");
{
  const { injectPerseverationCheck } = require("../lib/chat/cognitive-analyzer");
  const empty = { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };
  const hist = (lines: string[]) => lines.join("\n");

  // 3턴 연속 동일(잘림 변형 포함) → 마킹
  const r1 = injectPerseverationCheck(empty, "우리 어렸을 적엔 말이지, 밤에는", hist([
    "[방금] 사용자: 우리 어렸을 적엔 말이지, 밤에",
    "[방금] AI: 어떤 이야기인지 궁금해요!",
    "[방금] 사용자: 우리 어렸을 적엔 말이지, 밤에는",
    "[방금] AI: 천천히 들려주세요!",
  ]));
  check("3연속 반복 → memory_immediate 마킹", r1.isAnomaly && r1.cognitiveChecks.some((c: any) => c.domain === "memory_immediate" && c.score >= 1));

  // 2턴 반복만으로는 미발동 (오탐 방지)
  const r2 = injectPerseverationCheck(empty, "오늘 날씨 참 좋네", hist([
    "[방금] 사용자: 오늘 날씨 참 좋네",
    "[방금] AI: 산책 어떠세요?",
    "[방금] 사용자: 텃밭에 물 줘야겠어",
    "[방금] AI: 좋은 생각이에요!",
  ]));
  check("직전 1회만 반복 → 미발동", !r2.isAnomaly);

  // 짧은 맞장구 반복은 제외 (응/그래)
  const r3 = injectPerseverationCheck(empty, "그래그래", hist([
    "[방금] 사용자: 그래그래",
    "[방금] AI: 네!",
    "[방금] 사용자: 그래그래",
    "[방금] AI: 좋아요!",
  ]));
  check("짧은 맞장구 반복 → 미발동", !r3.isAnomaly);
}

// ── #15: 검진 중단 死정규식 — "그만두면 신경 쓰여"(서술)가 검진 중단으로 오발동 금지 ──
console.log("\n[mental-escape] '그만두면' 서술 → 검진 오중단 금지 (2026-06-15 BFI-10 라이브 FP)");
{
  const { isAbortIntent } = require("../lib/health/mental-flow");
  check("'그만할래' 중단 의사 감지", isAbortIntent("이제 그만할래") === true);
  check("'그만하자' 중단 의사 감지", isAbortIntent("이제 그만하자") === true);
  check("'그만둬' 중단 의사 감지", isAbortIntent("그만둬") === true);
  check("'그만두면 신경쓰여' 서술 → 오중단 금지", isAbortIntent("그런 편이에요. 중간에 그만두면 계속 신경 쓰여서요") === false);
  check("'그만두고 다른거' 서술 → 오중단 금지", isAbortIntent("그건 그만두고 다른 일을 했어요") === false);
  check("'중단/취소' 중단 의사 유지", isAbortIntent("검사 중단할게요") === true);
}

// ── #16: TTS 검진 머리말 낭독 — "1/10."이 "십분의 일"(분수)로 읽히는 문제 ──
console.log("\n[tts-text] '1/10.' 머리말 → '첫 번째 문제' 자연화 (2026-06-15 사용자 피드백)");
{
  const { sanitizeForTts } = require("../lib/chat/tts-text");
  check("'1/10.' → '첫 번째 문제'", sanitizeForTts("1/10. 지난 2주 동안").startsWith("첫 번째 문제."));
  check("'10/10.' → '열 번째 문제'", sanitizeForTts("10/10. 상상력이 풍부한 편이다").startsWith("열 번째 문제."));
  check("'1/10' 분수 표기 제거(낭독)", !sanitizeForTts("3/9. 잠들기 어렵거나").includes("/"));
  check("일반 분수 '2/3 정도'는 보존(머리말 아님)", sanitizeForTts("하루 2/3 정도는 그래요").includes("2/3"));
  check("'2주' 같은 정상 숫자 보존", sanitizeForTts("2주의 절반 이상이요").includes("2주"));
  check("물결표 제거 유지", !sanitizeForTts("1~2개 정도").includes("~"));
}

// ── #17: 반려동물 슬롯 추출 — 회상 견고성(두부 사례) + 음식 '두부' FP 차단 (2026-06-16) ──
console.log("\n[pet-slot] 반려동물 추출(종 확인 필수)");
{
  const { extractPetFromText } = require("../lib/chat/profile-extractor");
  const r1 = extractPetFromText("요즘 고양이를 키우기 시작했어요. 이름은 두부예요");
  check("'고양이 키우기…이름은 두부' → 고양이 두부", !!r1 && r1.species === "고양이" && r1.name === "두부");
  const r2 = extractPetFromText("고양이 두부를 키워");
  check("'고양이 두부를 키워' → 고양이 두부", !!r2 && r2.species === "고양이" && r2.name === "두부");
  const r3 = extractPetFromText("얼마 전에 강아지를 입양했어");
  check("'강아지 입양'(이름 없음) → 강아지", !!r3 && r3.species === "강아지" && r3.name === null);
  check("음식 '두부'(종 없음) → 미추출", extractPetFromText("저녁에 두부 넣고 된장찌개 끓였어") === null);
  check("종은 있으나 소유동사 없음 → 미추출", extractPetFromText("고양이는 참 귀여운 동물이지") === null);
}

// ── #18: 거짓 부정 단언 가드 — 확정 사실을 "안 한다고 하셨다"고 단언 시 제거 (2026-06-16 라이브) ──
console.log("\n[false-negation] 확정사실 거짓 부정 단언 제거");
{
  const { detectFalseNegationAgainstFacts } = require("../lib/chat/fact-checker");
  const a = detectFalseNegationAgainstFacts("그럼요. 고양이는 안 키우신다고 하셨잖아요. 오늘 점심 드셨어요?", ["고양이", "두부"]);
  check("확정사실 부정단언 문장 제거", a.removed.length === 1 && !a.cleaned.includes("안 키우"));
  const b = detectFalseNegationAgainstFacts("재미없다고 하셨죠. 속상하셨겠어요.", ["고양이", "두부"]);
  check("확정사실 아닌 정상 부정반영은 보존", b.removed.length === 0);
  check("affirmed 없으면 미발동", detectFalseNegationAgainstFacts("안 키우신다고 하셨잖아요", []).removed.length === 0);
}

// ── #19: keyFacts 프롬프트 렌더 — 구조화 사실 유실 방지 (2026-06-16) ──
console.log("\n[keyfacts] 요약 keyFacts 프롬프트 주입");
{
  const { renderKeyFacts } = require("../lib/chat/summarizer");
  const s = renderKeyFacts(JSON.stringify({ hometown: "춘천", favorites: ["두부"], events: [{ when: "다음달", what: "제주여행" }] }));
  check("사물·이벤트 렌더", s.includes("춘천") && s.includes("두부") && s.includes("제주여행"));
  check("빈/깨진 keyFacts 방어", renderKeyFacts("") === "" && renderKeyFacts("{bad") === "");
}

// ── #20: 참여도 감지 — 단답·반복 시 발화량·질문 축소 (과다발화 루프 방지, 2026-06-16) ──
console.log("\n[engagement] 저참여 감지 + 발화 페이스 hint");
{
  const { detectLowEngagement, buildEngagementHint } = require("../lib/chat/engagement");
  check("단답 '응' → very-low", detectLowEngagement("응", []) === "very-low");
  check("단답 '몰라' → very-low", detectLowEngagement("몰라", []) === "very-low");
  check("짧은 반복 → very-low", detectLowEngagement("그래", ["그래"]) === "very-low");
  check("정상 문장 → none", detectLowEngagement("어제 손주가 놀러 와서 같이 저녁을 맛있게 먹었어요", []) === "none");
  check("very-low hint는 새 질문 억제", buildEngagementHint("very-low").includes("새 질문"));
  check("none hint는 기존 기본('답변 직전 점검') 유지", buildEngagementHint("none").includes("답변 직전 점검"));
}

// ── #21: 인지 등급 적응 — severity→프롬프트 폐루프 (중증/고위험만, 2026-06-16) ──
console.log("\n[cognitive-adapt] 인지 등급별 대화 난이도 적응");
{
  const { buildCognitiveAdaptationHint } = require("../lib/health/cognitive-level");
  check("중증 → 1~2문장 짧게 지시", buildCognitiveAdaptationHint("중증").includes("1~2문장"));
  check("고위험 → 한 문장 지시", buildCognitiveAdaptationHint("고위험").includes("한 문장"));
  check("정상 → 적응 없음(빈 문자열, 현행 보존)", buildCognitiveAdaptationHint("정상") === "");
  check("경증 → 적응 없음", buildCognitiveAdaptationHint("경증") === "");
  check("평가전 → 적응 없음", buildCognitiveAdaptationHint("평가전") === "");
  check("적응 지시에 응급·안전 예외 포함(길이충돌 가드)", buildCognitiveAdaptationHint("고위험").includes("응급"));
}

// ── #22: 검진 결과 요청 감지 — 미완료 시 가짜 결과 환각 방지 (2026-06-16) ──
console.log("\n[mental-result] 검진 결과 요청 감지(환각 방지)");
{
  const { isMentalResultRequest } = require("../lib/health/mental-flow");
  check("'우울 점수 어때' → 결과요청", isMentalResultRequest("내 우울 점수 어때?") === true);
  check("'검사 결과 보여줘' → 결과요청", isMentalResultRequest("검사 결과 보여줘") === true);
  check("'점수 알려줘' → 결과요청", isMentalResultRequest("점수 알려줘") === true);
  check("'마음 건강 체크 해줘'(트리거) → 결과요청 아님", isMentalResultRequest("마음 건강 체크 해줘") === false);
  check("'오늘 날씨 좋네' → 결과요청 아님", isMentalResultRequest("오늘 날씨 좋네") === false);
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
