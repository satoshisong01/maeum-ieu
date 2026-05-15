// AI 발화에서 인지 선별 질문 패턴 자동 검출 → 도메인 기록 검증
// 목적: 같은 도메인 질문이 세션 내에 반복되지 않도록 score=0으로 미리 기록

const COGNITIVE_QUESTION_PATTERNS: Array<{ domain: string; pattern: RegExp }> = [
  { domain: "language", pattern: /(백문이 불여일견|티끌 모아 태산|호랑이도 제 말 하면|소문난 잔치|세 살 (?:적|버릇)|아니 땐 굴뚝|등잔 밑이 어둡|돌다리도 두들겨|가는 말이 고와야)/ },
  { domain: "language", pattern: /(?:속담|관용구).*(?:무슨\s*뜻|뜻이\s*뭐)/ },
  { domain: "language", pattern: /(간장\s*공장\s*공장장|저기 저 분이|중앙청 창살)/ },
  { domain: "language", pattern: /(?:똑같이\s*따라|그대로\s*따라|이대로\s*따라|따라\s*해\s*보세|따라\s*말씀해)/ },
  { domain: "language", pattern: /(?:1분\s*안에|일\s*분\s*안에|최대한\s*많이).*(?:동물|음식|과일|단어)/ },
  { domain: "language", pattern: /(?:'[가-힣]'|"[가-힣]"|[가-힣])(?:로|으로)\s*시작하는\s*(?:동물|단어|음식|이름)/ },
  { domain: "memory_immediate", pattern: /(?:방금|지금)\s*(?:외워|기억해)\s*(?:두|보세|주세)/ },
  { domain: "memory_delayed", pattern: /(?:아까|좀\s*전에)\s*(?:외워|드린|말씀드린)\s*(?:단어|세\s*개|세개|3개|다섯\s*개|5개)/ },
  { domain: "memory_delayed", pattern: /(?:아까|좀\s*전에).*(?:기억\s*나|회상해)/ },
  { domain: "attention_calculation", pattern: /\d+\s*에서\s*\d+\s*(?:을|를)?\s*(?:빼|더|곱|나눠|나누)/ },
  { domain: "attention_calculation", pattern: /100\s*에서\s*7\s*씩|삼천리강산.*거꾸로|만원\s*내(?:면|고).*거스름/ },
  { domain: "orientation_time", pattern: /오늘\s*(?:무슨\s*요일|며칠|몇\s*월|날짜)|지금\s*몇\s*시|올해\s*몇\s*년|지금이\s*(?:몇년|몇\s*년)/ },
  { domain: "orientation_time", pattern: /요즘\s*무슨\s*계절|지금\s*무슨\s*계절/ },
  { domain: "orientation_place", pattern: /(?:지금|할아버지|할머니)\s*(?:어디|어느\s*곳).*계세|여기(?:가)?\s*어디/ },
  { domain: "judgment", pattern: /(?:길에서\s*지갑(?:을|를)?\s*주우면|불이\s*났을\s*때|화재.*어떻게|약을\s*잘못\s*드시면)/ },
];

function detectCognitiveQuestions(aiResponse: string): string[] {
  const out = new Set<string>();
  for (const { domain, pattern } of COGNITIVE_QUESTION_PATTERNS) {
    if (pattern.test(aiResponse)) out.add(domain);
  }
  return Array.from(out);
}

const cases: Array<{ ai: string; expect: string[]; label: string }> = [
  // 핵심 회귀: 백문이 불여일견 — DB 사이클에서 3번 반복됐던 케이스
  { ai: "할아버지, 백문이 불여일견이라는 말 들어보셨어요? 무슨 뜻일까요?", expect: ["language"], label: "백문이 불여일견 질문" },
  // 핵심 회귀: 간장 공장 따라말하기 — 3번 반복
  { ai: "할아버지, 제가 말씀드린 거 똑같이 따라 해 주세요. '간장 공장 공장장은 강 공장장이다'", expect: ["language"], label: "간장 공장 따라말하기" },
  // 유창성
  { ai: "할아버지, 1분 안에 동물 이름 최대한 많이 말씀해 보실래요?", expect: ["language"], label: "유창성 — 동물 이름" },
  { ai: "할아버지, 'ㄱ'으로 시작하는 음식 이름 몇 개 알려주세요.", expect: ["language"], label: "음소 유창성 — ㄱ" },
  // 계산
  { ai: "할아버지, 79에서 7을 빼면 얼마예요?", expect: ["attention_calculation"], label: "계산 — 79-7" },
  { ai: "100에서 7씩 빼서 가 보시겠어요?", expect: ["attention_calculation"], label: "MMSE 100-7" },
  { ai: "할아버지, 만원 내고 3천원짜리 빵 사면 거스름돈은 얼마예요?", expect: ["attention_calculation"], label: "거스름돈 계산" },
  // 시간 지남력
  { ai: "할아버지, 오늘 무슨 요일이에요?", expect: ["orientation_time"], label: "시간 지남력 — 요일" },
  { ai: "지금 무슨 계절이지요?", expect: ["orientation_time"], label: "시간 지남력 — 계절" },
  // 장소 지남력
  { ai: "할아버지 지금 어디 계세요?", expect: ["orientation_place"], label: "장소 지남력" },
  // 지연 기억
  { ai: "할아버지, 아까 외워드린 단어 세 개 기억나세요?", expect: ["memory_delayed"], label: "지연 기억 회상" },
  // 즉시 기억
  { ai: "할아버지, 방금 외워두세요. 나무, 자동차, 모자.", expect: ["memory_immediate"], label: "즉시 기억 출제" },
  // 판단력
  { ai: "할아버지, 길에서 지갑을 주우면 어떻게 하시겠어요?", expect: ["judgment"], label: "판단력 — 지갑" },
  // Noop — 일상 대화는 탐지되면 안 됨
  { ai: "할아버지, 점심 맛있게 드셨어요?", expect: [], label: "일상 — 점심 인사" },
  { ai: "오늘은 산책 가시기 좋은 날씨예요.", expect: [], label: "일상 — 날씨" },
  { ai: "할머니 안녕하세요! 잘 지내셨어요?", expect: [], label: "일상 — 인사" },
  // 복합 — 한 발화에 여러 도메인은 잘 안 나오지만 검증
  { ai: "할아버지, 오늘 무슨 요일이에요? 그리고 100에서 7씩 빼면 얼마인가요?", expect: ["attention_calculation", "orientation_time"], label: "복합 — 시간+계산" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = detectCognitiveQuestions(c.ai).sort();
  const exp = [...c.expect].sort();
  const ok = got.length === exp.length && got.every((d, i) => d === exp[i]);
  if (ok) { console.log(`✓ ${c.label}`); pass++; }
  else { console.log(`✗ ${c.label}`); console.log(`   expected: ${JSON.stringify(exp)}`); console.log(`   got     : ${JSON.stringify(got)}`); fail++; }
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
