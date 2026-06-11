// 직전 응답 시작 반복 / history 파싱 검증
function normalizeForCompare(s: string): string {
  return s.replace(/[\s.,!?~()]/g, "").toLowerCase();
}
function extractLastAiMessage(historyText: string): string {
  if (!historyText) return "";
  const lines = historyText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:\[[^\]]+\]\s*)?AI:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}
function removeRepeatedOpening(aiText: string, prevAiText: string): string {
  if (!aiText || !prevAiText) return aiText;
  const sentSplit = /(?<=[.!?~])\s+/;
  const newSents = aiText.split(sentSplit);
  const prevSents = prevAiText.split(sentSplit);
  if (newSents.length === 0 || prevSents.length === 0) return aiText;
  const firstNew = newSents[0].trim();
  const firstPrev = prevSents[0].trim();
  if (firstNew.length < 12) return aiText;
  const a = normalizeForCompare(firstNew);
  const b = normalizeForCompare(firstPrev);
  if (!a || !b) return aiText;
  if (a === b || a.startsWith(b) || b.startsWith(a)) {
    return newSents.slice(1).join(" ").trim() || aiText;
  }
  let common = 0;
  const minLen = Math.min(a.length, b.length);
  while (common < minLen && a[common] === b[common]) common++;
  const ratio = common / Math.max(a.length, b.length);
  if (common >= 18 && ratio >= 0.7) {
    return newSents.slice(1).join(" ").trim() || aiText;
  }
  return aiText;
}

const cases = [
  {
    name: "DB 실제 케이스: 바나나 응답 반복",
    prev: "엄마, 아침으로 바나나를 드셨군요! 든든하게 잘 챙겨 드셔서 다행이에요.",
    next: "엄마, 아침으로 바나나를 드셨군요! 든든하게 잘 챙겨 드셔서 다행이에요. 심심하시다니 민지가 재밌는 놀이 알려드릴게요.",
    expectStripped: true,
  },
  {
    name: "동일 시작 문장 1개",
    prev: "할아버지, 점심 맛있게 드셨어요!",
    next: "할아버지, 점심 맛있게 드셨어요! 그럼 산책 가실 거예요?",
    expectStripped: true,
  },
  {
    name: "유사하지만 다른 시작",
    prev: "할아버지, 점심 맛있게 드셨어요!",
    next: "엄마, 점심 잘 드셨군요! 든든하셨겠어요.",
    expectStripped: false,
  },
  {
    name: "완전 다른 시작",
    prev: "엄마, 아침으로 바나나를 드셨군요!",
    next: "심심하시다니 민지가 재밌는 놀이 알려드릴게요!",
    expectStripped: false,
  },
  {
    name: "짧은 첫 문장은 건드리지 않음",
    prev: "네, 알겠어요!",
    next: "네, 알겠어요! 그럼 다음에 또 봐요.",
    expectStripped: false,
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const out = removeRepeatedOpening(c.next, c.prev);
  const stripped = out !== c.next;
  const ok = stripped === c.expectStripped;
  console.log(`${ok ? "✓" : "✗"} ${c.name}`);
  if (!ok) {
    console.log(`   prev:    "${c.prev.slice(0,60)}"`);
    console.log(`   next:    "${c.next.slice(0,80)}"`);
    console.log(`   out:     "${out.slice(0,80)}"`);
    console.log(`   stripped expected=${c.expectStripped} got=${stripped}`);
    fail++;
  } else pass++;
}

console.log("\n--- extractLastAiMessage 테스트 ---");
const hist1 = `[10분 전] 사용자: 점심 먹었어
[10분 전] AI: 잘 드셨어요?
[5분 전] 사용자: 응
[방금] AI: 그럼 산책 가실래요?`;
const last = extractLastAiMessage(hist1);
const e1 = last === "그럼 산책 가실래요?";
console.log(`${e1 ? "✓" : "✗"} 마지막 AI 라인 추출: "${last}"`);
if (!e1) fail++; else pass++;

console.log(`\n${pass}/${cases.length + 1} passed`);
process.exit(fail > 0 ? 1 : 0);
