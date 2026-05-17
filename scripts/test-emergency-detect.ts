// detectEmergency L1/L2/L3 분류 + 과거/비유 가드 검증
import { detectEmergency, shouldEscalateL1ToL2 } from "../lib/chat/emergency";

interface Case { text: string; level: number; category: string; label: string }

const cases: Case[] = [
  // ─── L3 즉시 ────────────────────────────────────────────────
  { text: "119에 전화해줘 빨리", level: 3, category: "medical_acute", label: "L3 — 119 호출" },
  { text: "구급차 좀 불러줘", level: 3, category: "medical_acute", label: "L3 — 구급차" },
  { text: "숨이 안 쉬어져 답답해", level: 3, category: "medical_acute", label: "L3 — 호흡곤란" },
  { text: "가슴이 너무 아파서 못 견디겠어", level: 3, category: "medical_acute", label: "L3 — 가슴 통증" },
  { text: "방금 화장실 가다가 쓰러졌어", level: 3, category: "fall_injury", label: "L3 — 낙상" },
  { text: "코피가 안 멈춰 피가 계속 나", level: 3, category: "bleeding", label: "L3 — 출혈" },
  { text: "약을 두 번 먹은 것 같아 잘못 먹었어", level: 3, category: "medication_error", label: "L3 — 약 오용" },
  { text: "이제 정말 죽고 싶어 너무 힘들어", level: 3, category: "suicidal", label: "L3 — 자살 의도" },
  { text: "왼쪽 팔이 안 움직여 힘이 안 들어가", level: 3, category: "medical_acute", label: "L3 — 뇌졸중 시그널" },

  // ─── L2 주의 ────────────────────────────────────────────────
  { text: "허리가 너무 아파 잠을 못 잤어", level: 2, category: "severe_pain", label: "L2 — 심한 통증" },
  { text: "어지러워서 못 일어나겠어", level: 2, category: "dizziness_help", label: "L2 — 어지러움+못일어남" },
  { text: "눈앞이 캄캄해", level: 2, category: "dizziness_help", label: "L2 — 시야 캄캄" },
  { text: "아무나 좀 도와줘 혼자 못 일어나겠어", level: 2, category: "dizziness_help", label: "L2 — 도움 호소" },
  { text: "열이 펄펄 나고 계속 토해", level: 2, category: "medical_acute", label: "L2 — 발열 구토" },

  // ─── L1 관찰 ────────────────────────────────────────────────
  { text: "오늘은 기운이 하나도 없어", level: 1, category: "weakness_trend", label: "L1 — 무기력" },
  { text: "요즘 입맛이 하나도 없어 밥맛 없어", level: 1, category: "appetite_loss", label: "L1 — 식욕 저하" },
  { text: "며칠째 잠을 못 자서 힘드네", level: 1, category: "sleep_distress", label: "L1 — 수면 곤란" },
  { text: "허리가 계속 아파서 힘들어", level: 1, category: "severe_pain", label: "L1 — 통증 지속" },

  // ─── 과거 회상 — 응급 아님 ──────────────────────────────────
  { text: "옛날에 쓰러진 적 있었어 그때 정말 무서웠지", level: 0, category: "none", label: "과거 — 쓰러짐 회상" },
  { text: "어릴 때 119 부른 적 한 번 있었어", level: 0, category: "none", label: "과거 — 119 회상" },
  { text: "TV에서 가슴이 찢어진다는 사람 보던데", level: 0, category: "none", label: "TV — 가슴 통증 시청" },
  { text: "꿈에서 피가 막 나는 거야 무섭게", level: 0, category: "none", label: "꿈 — 출혈" },

  // ─── 비유/감탄 — 강등 ──────────────────────────────────────
  { text: "맛있어 죽겠어 정말 좋아", level: 0, category: "none", label: "비유 — 맛있어 죽겠다" },
  { text: "너무 더워 죽겠다", level: 0, category: "none", label: "비유 — 더워 죽겠다" },
  { text: "피곤해서 쓰러질 것 같아", level: 2, category: "medical_acute", label: "비유 — 피곤 강등 (L3→L2)" },

  // ─── 정상 일상 ─────────────────────────────────────────────
  { text: "점심 맛있게 먹었어", level: 0, category: "none", label: "정상 — 점심" },
  { text: "오늘 날씨 좋네", level: 0, category: "none", label: "정상 — 날씨" },
  { text: "허리가 좀 시큰거려서 걱정이야", level: 0, category: "none", label: "정상 — 가벼운 불편 (L1 미만)" },
  { text: "약 잘 챙겨먹고 있어", level: 0, category: "none", label: "정상 — 약 복용 (정상)" },
  { text: "내일 손주 본다고 좋아 죽겠어", level: 0, category: "none", label: "비유 — 좋아 죽겠다" },

  // ─── 위험 — 과거여도 보존되어야 하는 케이스 ──────────────
  // suicidal과 medication_error는 과거 표현이 섞여도 L2로 보존(과소평가 방지)
  { text: "예전에 약을 잘못 먹은 적이 있는데 지금도 헷갈려", level: 2, category: "medication_error", label: "과거 + medication → L2 유지" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = detectEmergency(c.text);
  const ok = r.level === c.level && r.category === c.category;
  if (ok) { console.log(`✓ ${c.label}`); pass++; }
  else {
    console.log(`✗ ${c.label}`);
    console.log(`   text:     "${c.text}"`);
    console.log(`   expected: level=${c.level} cat=${c.category}`);
    console.log(`   got     : level=${r.level} cat=${r.category} ev="${r.evidence}"`);
    fail++;
  }
}

// 누적 승격 로직
console.log("\n--- shouldEscalateL1ToL2 ---");
const escTests: Array<{ count: number; expect: boolean }> = [
  { count: 0, expect: false },
  { count: 1, expect: false },
  { count: 2, expect: false },
  { count: 3, expect: true },
  { count: 5, expect: true },
];
for (const t of escTests) {
  const got = shouldEscalateL1ToL2(t.count);
  if (got === t.expect) { console.log(`✓ count=${t.count} → ${got}`); pass++; }
  else { console.log(`✗ count=${t.count} expected ${t.expect} got ${got}`); fail++; }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
