// STT 신뢰도 평가 — 통과/실패 케이스 검증
import { evaluateSttConfidence, buildClarificationReply } from "../../lib/chat/stt-confidence";

interface Case { text: string; pass: boolean; label: string; durationMs?: number }

const cases: Case[] = [
  // ─── 통과 (정상 발화) ─────────────────────────────────────
  { text: "점심 김치찌개 먹었어 맛있더라", pass: true, label: "정상 — 점심 식사" },
  { text: "오늘 날씨가 좋네", pass: true, label: "정상 — 날씨" },
  { text: "응", pass: true, label: "정상 — 짧은 긍정 (2글자)" },
  { text: "그래", pass: true, label: "정상 — 짧은 답" },
  { text: "민지야 안녕", pass: true, label: "정상 — 인사" },
  { text: "동탄1신도시에 살아", pass: true, label: "정상 — 영숫자 일부 섞임" },
  { text: "5월 18일이지 오늘", pass: true, label: "정상 — 숫자 일부" },
  { text: "허리가 좀 시큰거려서 걱정이야 ㅎㅎ", pass: true, label: "정상 — 가벼운 이모티콘" },

  // ─── 실패 — 빈/짧음 ─────────────────────────────────────
  { text: "", pass: false, label: "실패 — 빈 문자열" },
  { text: " ", pass: false, label: "실패 — 공백만" },
  { text: "ㅇ", pass: false, label: "실패 — 1글자" },

  // ─── 실패 — 명시적 STT 실패 마커 ──────────────────────────
  { text: "(음성을 인식하지 못했습니다)", pass: false, label: "실패 — 인식 실패 메시지" },
  { text: "음성을 인식하지 못했습니다", pass: false, label: "실패 — 마커 (괄호 없음)" },
  { text: "(들리지 않습니다)", pass: false, label: "실패 — 들리지 않음" },
  { text: "noise", pass: false, label: "실패 — 영문 noise" },

  // ─── 실패 — 한글 비율 낮음 ────────────────────────────────
  { text: "asdf qwer zxcv", pass: false, label: "실패 — 영문 키보드 잡음" },
  { text: "1234567890", pass: false, label: "실패 — 숫자만" },

  // ─── 실패 — 동일 문자 burst ───────────────────────────────
  { text: "아아아아아", pass: false, label: "실패 — 모음 반복 burst" },
  { text: "음음음음음음", pass: false, label: "실패 — 음 반복" },

  // ─── 실패 — Filler만 ──────────────────────────────────────
  { text: "음...", pass: false, label: "실패 — 음... filler" },
  { text: "어어 ", pass: false, label: "실패 — 어어 filler" },
  { text: "그", pass: false, label: "실패 — 1글자 그 (length<2)" },

  // ─── 실패 — 자모 분리 ─────────────────────────────────────
  { text: "ㅁㅁㅁ", pass: false, label: "실패 — 자음만" },
  { text: "ㅏㅏ ㅏ", pass: false, label: "실패 — 모음만" },

  // ─── 실패 — 음성 길이 대비 텍스트 짧음 ──────────────────
  { text: "응", pass: false, label: "실패 — 5초 발화인데 1글자", durationMs: 5000 },

  // ─── 실패 — 특수문자만 ────────────────────────────────────
  { text: "...", pass: false, label: "실패 — 점만" },
  { text: "??", pass: false, label: "실패 — 물음표만" },

  // ─── 경계 케이스 (통과) ───────────────────────────────────
  { text: "ㅋㅋㅋ 그 드라마 진짜 재밌더라", pass: true, label: "통과 — ㅋㅋ 포함 정상 문장" },
  { text: "아 맞다 약 먹어야지", pass: true, label: "통과 — '아' 시작 정상 문장" },

  // ─── 실패 — 어절 반복 환각 (2026-07-10 실사례: "지금" ×47) ──
  { text: Array(47).fill("지금").join(" "), pass: false, label: "실패 — 지금 ×47 (실DB 사례)" },
  { text: "밥 먹었어 지금 지금 지금 지금 지금 지금 지금", pass: false, label: "실패 — 정상문장+반복꼬리 (run 6)" },
  { text: "몰라 몰라 몰라 몰라 몰라", pass: false, label: "실패 — 한 단어만 5회 (정보량 없음)" },
  { text: "네 지금 네 지금 네 지금 네 지금", pass: false, label: "실패 — 2어절 교대 반복 (어휘 붕괴)" },
  { text: "지금, 지금. 지금, 지금. 지금, 지금.", pass: false, label: "실패 — 구두점 변주 반복 (토큰 정규화)" },

  // ─── 통과 — 실DB 사례 (2026-07-10, 짧은 맞장구+정상 문장) ──
  { text: "네, 네, 네. 민기야. 잘했니?", pass: true, label: "통과 — 네네네 + 정상 문장 (실DB)" },

  // ─── 통과 — 자연스러운 강조 반복 ───────────────────────────
  { text: "아파 아파 아파", pass: true, label: "통과 — 강조 반복 3회" },
  { text: "빨리 빨리 빨리 빨리 와", pass: true, label: "통과 — 강조 반복 4회 + 내용" },
  { text: "그래 그래 맞아 맞아 옛날에 그랬지", pass: true, label: "통과 — 맞장구 반복" },

  // ─── 통과 — 조난 어휘 반복은 게이트 면제 (재질문에 막히면 응급 대응 지연) ──
  { text: "아파 아파 아파 아파 아파", pass: true, label: "통과 — 조난 외침 (아파 ×5)" },
  { text: "살려줘 살려줘 살려줘 살려줘 살려줘 살려줘", pass: true, label: "통과 — 조난 외침 (살려줘 ×6)" },
  { text: "아이고 아이고 아이고 아이고 아이고", pass: true, label: "통과 — 곡소리 (아이고 ×5)" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = evaluateSttConfidence(c.text, c.durationMs);
  const ok = r.pass === c.pass;
  if (ok) { console.log(`✓ ${c.label}  (conf=${r.confidence.toFixed(2)})`); pass++; }
  else {
    console.log(`✗ ${c.label}`);
    console.log(`   text: "${c.text}"`);
    console.log(`   expected pass=${c.pass}, got pass=${r.pass} (conf=${r.confidence}, reason="${r.reason}")`);
    fail++;
  }
}

// 재질문 멘트
console.log("\n--- buildClarificationReply ---");
for (let i = 1; i <= 4; i++) {
  const reply = buildClarificationReply("할아버지", "민지", i);
  console.log(`  [${i}] ${reply}`);
}

console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
