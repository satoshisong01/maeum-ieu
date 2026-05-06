// fixWordChainStart 단위 검증
const WORDCHAIN_PROPOSED = /(이번엔|이번에는|이번에)\s*'([가-힣]{1,5})'(?:이?라고)/;
const WORDCHAIN_REQUEST = /'([가-힣])'(?:로|으로)\s*시작하는\s*단어/g;

function fixWordChainStart(text: string): string {
  if (!text) return text;
  const proposed = text.match(WORDCHAIN_PROPOSED);
  if (!proposed) return text;
  const word = proposed[2];
  if (!word) return text;
  const lastChar = word[word.length - 1];
  return text.replace(WORDCHAIN_REQUEST, (full, asked: string) => {
    if (asked === lastChar) return full;
    return full.replace(`'${asked}'`, `'${lastChar}'`);
  });
}

const cases = [
  {
    name: "DB 버그1: 가방 → 가 (틀림) → 방 으로 교정",
    input: "엄마, '국가' 맞아요! 정말 잘하셨어요. 민지가 이번엔 '가방'이라고 할게요. 엄마는 '가'로 시작하는 단어 아무거나 말씀해주세요!",
    expectAsked: "방",
  },
  {
    name: "DB 버그2: 위성 → 위 (틀림) → 성 으로 교정",
    input: "엄마, '가위' 맞아요! 정말 잘하셨어요. 민지가 이번엔 '위성'이라고 할게요. 엄마는 '위'로 시작하는 단어 아무거나 말씀해주세요!",
    expectAsked: "성",
  },
  {
    name: "정상 케이스: 자동차 → 차 (변경 없음)",
    input: "엄마, '과자' 맞아요! 민지가 이번엔 '자동차'라고 할게요. 엄마는 '차'로 시작하는 단어 말씀해주세요!",
    expectAsked: "차",
  },
  {
    name: "받침 있는 끝글자: 비빔밥 → 밥",
    input: "민지가 이번엔 '비빔밥'이라고 할게요. 엄마는 '비'로 시작하는 단어 말씀해주세요!",
    expectAsked: "밥",
  },
  {
    name: "AI 단어 제시 없음: 변경 안 함",
    input: "엄마, '바나나' 맞아요! 정말 잘하셨네요.",
    expectAsked: null,
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const out = fixWordChainStart(c.input);
  const m = out.match(/'([가-힣])'(?:로|으로)\s*시작하는\s*단어/);
  const askedAfter = m ? m[1] : null;
  const ok = askedAfter === c.expectAsked;
  console.log(`${ok ? "✓" : "✗"} ${c.name}`);
  console.log(`  asked after: '${askedAfter}' (expected '${c.expectAsked}')`);
  if (!ok) {
    console.log(`  out: ${out}`);
    fail++;
  } else pass++;
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
