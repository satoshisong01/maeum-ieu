// stripReasoningTrace 유닛 스모크 테스트
function stripReasoningTrace(text: string): string {
  if (!text) return text;
  let t = text.trim();
  if (!t) return t;
  t = t.replace(/^\s*(?:```(?:thinking|thought)?\s*)?(?:thought|thinking|reasoning|analysis|plan|scratchpad)\s*:?\s*/i, "");
  t = t.replace(/^\s*\*{2,}\s*(?:thought|thinking|reasoning|analysis)[^*\n]*\*{2,}\s*/gi, "");
  const segments = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
  if (segments.length === 0) return t;
  const hasHangul = (s: string) => /[가-힣]/.test(s);
  const hangulRatio = (s: string) => {
    const han = (s.match(/[가-힣]/g) || []).length;
    const letters = (s.match(/[a-zA-Z가-힣]/g) || []).length;
    return letters === 0 ? 0 : han / letters;
  };
  if (!hasHangul(t)) return t;
  let startIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    if (hangulRatio(segments[i]) >= 0.4) { startIdx = i; break; }
    if (i === segments.length - 1) startIdx = 0;
  }
  return segments.slice(startIdx).join(" ").trim();
}

const cases = [
  {
    name: "thought prefix + 한글",
    input: `thought The user is asking for ideas on how to utilize energy storage. I should respond in Korean.\n\n할아버지, 스마트 팜에 에너지 저장장치를 쓰시려고요? 재생에너지와 함께 쓰면 효율이 좋을 거예요.`,
  },
  {
    name: "긴 영문 reasoning + 한글",
    input: `The user's last input was "음성을 인식하지 못했습니다". This means the user likely said something but was not transcribed. I should prompt them to repeat.\n민지가 잘 못 들었나 봐요, 다시 한 번 말씀해 주시겠어요?`,
  },
  {
    name: "**Thinking** 블록",
    input: `**Thinking about context** let me respond naturally.\n할머니, 오늘 날씨가 참 좋네요.`,
  },
  {
    name: "정상 한글 (그대로)",
    input: `할아버지, 오늘 기분 좋으시다니 저도 기뻐요. 어떻게 지내세요?`,
  },
  {
    name: "영어 단어 섞인 정상 (그대로)",
    input: `할아버지, TV에서 BTS 공연 보셨어요? 재밌으셨겠어요.`,
  },
];

for (const c of cases) {
  const out = stripReasoningTrace(c.input);
  console.log(`\n--- ${c.name} ---`);
  console.log(`in : ${c.input.slice(0, 80)}${c.input.length > 80 ? '…' : ''}`);
  console.log(`out: ${out.slice(0, 80)}${out.length > 80 ? '…' : ''}`);
  console.log(`시작문자: ${/^[가-힣]/.test(out) ? '한글 ✓' : '한글 아님 ❌'}`);
}
