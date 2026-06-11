function normalizeHonorific(text: string, userHonorific: string = "할아버지"): string {
  if (!text) return text;
  const KIN = ["할아버지", "할머니", "아버지", "어머니", "아빠", "엄마",
    "아저씨", "이모", "삼촌", "고모"];
  const TITLE = ["회원님", "고객님", "선생님", "사장님", "어르신",
    "아버님", "어머님", "이모님", "삼촌님"];

  const filter = (arr: string[]) => arr.filter((h) => h !== userHonorific && !userHonorific.includes(h));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let out = text;
  const kinOffenders = filter(KIN).sort((a, b) => b.length - a.length);
  if (kinOffenders.length > 0) {
    const kinPat = new RegExp(`(?<![가-힣])(${kinOffenders.map(esc).join("|")})(?![가-힣])`, "g");
    out = out.replace(kinPat, userHonorific);
  }
  const titleOffenders = filter(TITLE).sort((a, b) => b.length - a.length);
  if (titleOffenders.length > 0) {
    const titlePat = new RegExp(`(?<![가-힣])(${titleOffenders.map(esc).join("|")})`, "g");
    out = out.replace(titlePat, userHonorific);
  }
  return out.replace(/(?<![가-힣])님\s*,/g, `${userHonorific},`);
}

const cases = [
  { in: "할아버지, 새벽부터 잠이 잘 안 오셨군요.", uh: "할아버지", expect: "할아버지, 새벽부터 잠이 잘 안 오셨군요." },
  { in: "회원님, 안녕하세요.", uh: "할아버지", expect: "할아버지, 안녕하세요." },
  // "아버지"는 KIN이고 양쪽 lookahead가 있으므로 일반 문장 속 "아버지" 단독은 치환됨.
  // 사용자 호칭이 "할아버지"여도 "아버지"는 substring이라 offenders에서 빠짐(자기 자신 부분).
  { in: "할아버지, 오늘은 아버지 마음이에요.", uh: "할아버지", expect: "할아버지, 오늘은 아버지 마음이에요." },
  { in: "어르신, 점심 드세요.", uh: "할아버지", expect: "할아버지, 점심 드세요." },
  { in: "할머니, 안녕하세요.", uh: "할아버지", expect: "할아버지, 안녕하세요." },
  { in: "이모, 잘 지내세요?", uh: "할머니", expect: "할머니, 잘 지내세요?" },
  // 외할아버지: KIN 패턴은 양쪽 한글 lookahead로 막아야 함
  { in: "외할아버지께서 오셨대요", uh: "할아버지", expect: "외할아버지께서 오셨대요" },
  { in: "어머님, 식사하셨어요?", uh: "할머니", expect: "할머니, 식사하셨어요?" },
  // 조사가 붙은 TITLE: lookbehind만 적용해서 치환되어야 함
  { in: "회원님과 고객님 모두", uh: "할아버지", expect: "할아버지과 할아버지 모두" },
  // 핵심 회귀 케이스: "할아버지" 호칭일 때 자기 자신 안의 "아버지" 매칭으로 "할할아버지" 만들면 안 됨
  { in: "할아버지, 식사 하셨어요?", uh: "할아버지", expect: "할아버지, 식사 하셨어요?" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const out = normalizeHonorific(c.in, c.uh);
  const ok = out === c.expect;
  console.log(`${ok ? "✓" : "✗"} [uh=${c.uh}] "${c.in}"`);
  if (!ok) {
    console.log(`   expected: "${c.expect}"`);
    console.log(`   got     : "${out}"`);
    fail++;
  } else pass++;
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
