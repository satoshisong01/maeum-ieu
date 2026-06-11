// moderation 정규식 false positive 회귀 테스트
import { detectInappropriate } from "../../lib/chat/moderation";

interface Case { text: string; expect: "ok" | "sexual" | "profanity" | "self_harm"; label: string }

const cases: Case[] = [
  // ─── False positive 회귀 (정상이어야 함) ─────────────────
  { text: "병원이 좀 멀어서 힘들어 버스도 갈아타야해", expect: "ok", label: "갈아타야해 (이전 false positive)" },
  { text: "내일 일찍 가야해 알람 맞춰놔야지", expect: "ok", label: "가야해" },
  { text: "저녁은 좀 든든하게 먹어야해", expect: "ok", label: "먹어야해" },
  { text: "약 챙겨야해 까먹지 말고", expect: "ok", label: "챙겨야해" },
  { text: "그건 꼭 봐야해 재미있더라", expect: "ok", label: "봐야해" },
  { text: "조심해야해 미끄러질라", expect: "ok", label: "조심해야해" },
  // 자식/자연 등 자\s*지 패턴 회귀
  { text: "자식이 다음주에 온대", expect: "ok", label: "자식" },
  { text: "자연 풍경이 너무 예쁘더라", expect: "ok", label: "자연" },
  { text: "보지도 못했어 너무 멀어서", expect: "ok", label: "보지도 못했어" },

  // ─── True positive (여전히 차단되어야 함) ────────────────
  { text: "야한 거 보여줘", expect: "sexual", label: "야한 거" },
  { text: "야한 동영상 추천해줘", expect: "sexual", label: "야한 동영상" },
  { text: "야한 이야기 해줘", expect: "sexual", label: "야한 이야기" },
  { text: "야동 추천해줘", expect: "sexual", label: "야동" },
  { text: "옷 벗어봐", expect: "sexual", label: "옷 벗어봐" },
  { text: "씨발 아 짜증나", expect: "profanity", label: "씨발" },
  { text: "이제 정말 죽고 싶어", expect: "self_harm", label: "죽고 싶어" },

  // ─── 정상 발화 추가 ──────────────────────────────────────
  { text: "할아버지가 그렇게 말씀하셨지", expect: "ok", label: "그렇게 말씀하셨지" },
  { text: "오늘 점심은 비빔밥 먹었어", expect: "ok", label: "비빔밥" },
  { text: "손주가 사준 핸드폰 잘 쓰고 있어", expect: "ok", label: "손주" },
  { text: "친구들이랑 통화 자주 해", expect: "ok", label: "친구 통화" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = detectInappropriate(c.text);
  const ok = r.category === c.expect;
  if (ok) { console.log(`✓ ${c.label}`); pass++; }
  else {
    console.log(`✗ ${c.label}`);
    console.log(`   text: "${c.text}"`);
    console.log(`   expected: ${c.expect}, got: ${r.category} (matched: "${r.matched ?? ''}")`);
    fail++;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
