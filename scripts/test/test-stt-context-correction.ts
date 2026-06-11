// 맥락 기반 STT 보정 — 직전 AI 발화 도메인에 맞춰 어휘 교정
import { correctTranscriptionByContext } from "../../lib/chat/stt-context-correction";

interface Case {
  ai: string;       // 직전 AI 발화
  user: string;     // STT 결과 (오인식 포함)
  expect: string;   // 보정 후 기대값
  label: string;
}

const cases: Case[] = [
  // ─── 음식 도메인 보정 ─────────────────────────────────────
  { ai: "할아버지, 점심 뭐 드셨어요?", user: "미빈밥 먹었어", expect: "비빔밥 먹었어", label: "음식 — 미빈밥→비빔밥" },
  { ai: "점심 메뉴는 어떠셨어요?", user: "비빔법 맛있더라", expect: "비빔밥 맛있더라", label: "음식 — 비빔법→비빔밥" },
  { ai: "오늘 아침은 뭘 드셨어요?", user: "미여국에 밥 말아먹었어", expect: "미역국에 밥 말아먹었어", label: "음식 — 미여국→미역국" },
  { ai: "저녁 메뉴 정하셨어요?", user: "김치 지께 끓이려고", expect: "김치찌개 끓이려고", label: "음식 — 김치 지께→김치찌개" },
  { ai: "할아버지 점심 드시고 뭐 하셨어요?", user: "덕국 한 그릇 먹고 산책 갔지", expect: "떡국 한 그릇 먹고 산책 갔지", label: "음식 — 덕국→떡국" },

  // ─── 약 도메인 보정 ──────────────────────────────────────
  { ai: "할아버지, 약은 잘 드셨어요?", user: "혈양약 챙겨먹었어", expect: "혈압약 챙겨먹었어", label: "약 — 혈양약→혈압약" },
  { ai: "약 복용은 어떠세요?", user: "당뇨야꾸 두 알 먹었지", expect: "당뇨약 두 알 먹었지", label: "약 — 당뇨야꾸→당뇨약" },
  { ai: "혈압은 괜찮으세요? 약 드셨어요?", user: "혈약은 아침에 먹었어", expect: "혈압약은 아침에 먹었어", label: "약 — 혈약→혈압약" },

  // ─── 장소 도메인 보정 ────────────────────────────────────
  { ai: "할아버지 어디 사세요?", user: "화성 동탕에 살아", expect: "화성 동탄에 살아", label: "장소 — 동탕→동탄" },
  { ai: "오늘 어느 동네 가셨어요?", user: "노이정에 잠깐 들렀어", expect: "노인정에 잠깐 들렀어", label: "장소 — 노이정→노인정" },
  { ai: "동네 어디서 친구 만나셨어요?", user: "경노당에서 만났지", expect: "경로당에서 만났지", label: "장소 — 경노당→경로당" },

  // ─── 가족 도메인 보정 ────────────────────────────────────
  { ai: "할아버지 아드님은 잘 지내세요?", user: "아드람이 다음주에 와", expect: "아드님이 다음주에 와", label: "가족 — 아드람→아드님" },
  { ai: "며느리분도 같이 오시나요?", user: "며느니랑 손주들 다 와", expect: "며느리랑 손주들 다 와", label: "가족 — 며느니→며느리" },

  // ─── 도메인 불일치 — 보정 안 됨 ──────────────────────────
  { ai: "오늘 날씨 어떠세요?", user: "미빈밥 먹었어", expect: "미빈밥 먹었어", label: "도메인 불일치 — 날씨 질문에 음식 단어 안 고침" },
  { ai: "기분이 어떠세요?", user: "혈양약 잘 챙기고 있어", expect: "혈양약 잘 챙기고 있어", label: "도메인 불일치 — 기분 질문에 약 안 고침" },

  // ─── 이미 정상 발화는 그대로 ─────────────────────────────
  { ai: "점심 뭐 드셨어요?", user: "비빔밥 먹었어", expect: "비빔밥 먹었어", label: "정상 발화 변경 없음" },
  { ai: "약 잘 챙기세요?", user: "혈압약 챙겨먹어요", expect: "혈압약 챙겨먹어요", label: "정상 약 발화 변경 없음" },

  // ─── 복수 매칭 ──────────────────────────────────────────
  { ai: "오늘 점심 메뉴는요?", user: "미빈밥에 김치 지께 같이 먹었어", expect: "비빔밥에 김치찌개 같이 먹었어", label: "복수 매칭 — 두 음식 같이 보정" },

  // ─── 조사 결합어 보존 ───────────────────────────────────
  { ai: "점심 뭐 드셨어요?", user: "미빈밥을 두 그릇이나 먹었어", expect: "비빔밥을 두 그릇이나 먹었어", label: "조사 보존 — 미빈밥을→비빔밥을" },

  // ─── 빈 입력 / 빈 AI 발화 — noop ─────────────────────────
  { ai: "", user: "미빈밥 먹었어", expect: "미빈밥 먹었어", label: "AI 발화 없음 → noop" },
  { ai: "점심 뭐 드셨어요?", user: "", expect: "", label: "사용자 빈 → noop" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = correctTranscriptionByContext(c.user, c.ai);
  const ok = r.corrected === c.expect;
  if (ok) {
    const note = r.changes.length > 0 ? `  (${r.changes.length}건 보정)` : "";
    console.log(`✓ ${c.label}${note}`);
    pass++;
  } else {
    console.log(`✗ ${c.label}`);
    console.log(`   ai:       "${c.ai}"`);
    console.log(`   user:     "${c.user}"`);
    console.log(`   expected: "${c.expect}"`);
    console.log(`   got     : "${r.corrected}"`);
    console.log(`   changes : ${JSON.stringify(r.changes)}`);
    fail++;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
