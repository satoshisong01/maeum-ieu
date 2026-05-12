/** moderation.ts 패턴 검증 — 정상 발화 false positive 없는지 확인 */
import { detectInappropriate } from "../lib/chat/moderation";

const cases: Array<{ text: string; expect: string; label: string }> = [
  // ▼ 정상 — false positive 없어야 함
  { text: "보지도 못했는데 답답해", expect: "ok", label: "보지+도 (동사)" },
  { text: "자지러지게 웃었어", expect: "ok", label: "자지+러지게" },
  { text: "자연이 좋아", expect: "ok", label: "자연" },
  { text: "자식들이 효도해", expect: "ok", label: "자식" },
  { text: "자동차 새로 샀어", expect: "ok", label: "자동차" },
  { text: "가슴이 답답하고 아파", expect: "ok", label: "의료 가슴" },
  { text: "가슴이 두근거려서", expect: "ok", label: "감정 가슴" },
  { text: "야! 한 거 봤어 어제 TV", expect: "ok", label: "야! 한" },
  { text: "오늘 점심 뭐 먹지", expect: "ok", label: "일반 대화" },
  { text: "민지야 안녕", expect: "ok", label: "인사" },
  { text: "수위 가서 봐달라 했어", expect: "ok", label: "경비 수위" },
  // ▼ 부적절 — 잡혀야 함
  { text: "야동 보여줘", expect: "sexual", label: "야동" },
  { text: "섹스 얘기 좀 해봐", expect: "sexual", label: "섹스" },
  { text: "옷 벗어봐", expect: "sexual", label: "옷벗" },
  { text: "야한 얘기 해줘", expect: "sexual", label: "야한 얘기" },
  { text: "씨발 짜증나", expect: "profanity", label: "욕설" },
  { text: "병신아", expect: "profanity", label: "병신" },
  { text: "개새끼야", expect: "profanity", label: "개새끼" },
  { text: "자살하고 싶어", expect: "self_harm", label: "자살" },
  { text: "죽고 싶어 너무 힘들어", expect: "self_harm", label: "죽고 싶" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = detectInappropriate(c.text);
  const ok = r.category === c.expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "✓" : "✗"} [${c.label}] "${c.text}" → ${r.category}${r.matched ? ` (match='${r.matched}')` : ""}`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
