/**
 * 종합 위험도 4단계 등급 판정 검증 (정상/경증/중증/고위험).
 *
 * ① 경계값 정확성 (0.3 / 0.8 / 1.5 전후)
 * ② 가중 평균(computeOverallAvg) 정확성
 * ③ "답변 패턴 → 누적 점수 → 등급" 시나리오 다수 (경우의 수 많이)
 *
 * 사용: npx tsx scripts/tier-verify.ts [round]
 */
import { classifySeverity, computeOverallAvg, TIER_BOUNDS } from "../lib/health/severity";
import * as fs from "fs";

const round = process.argv[2] || "1";
let pass = 0, fail = 0;
const detail: string[] = [];
function check(name: string, got: unknown, exp: unknown) {
  const ok = got === exp;
  if (ok) pass++; else fail++;
  detail.push(`| ${ok ? "O" : "✗ FAIL"} | ${name} | ${exp} | ${got} |`);
}

// ── ① 경계값 정확성 ──
const B = [
  [-1, "평가전"], [0, "정상"], [0.0, "정상"], [0.29, "정상"], [0.299, "정상"],
  [TIER_BOUNDS.normal, "경증"], [0.3, "경증"], [0.5, "경증"], [0.79, "경증"], [0.799, "경증"],
  [TIER_BOUNDS.mild, "중증"], [0.8, "중증"], [1.0, "중증"], [1.49, "중증"], [1.499, "중증"],
  [TIER_BOUNDS.moderate, "고위험"], [1.5, "고위험"], [1.8, "고위험"], [2.0, "고위험"],
] as const;
for (const [v, exp] of B) check(`경계 overallAvg=${v}`, classifySeverity(v as number).tier, exp);

// ── ② 가중 평균 정확성 ──
check("가중평균 [(0,3),(2,1)] = 0.5", Number(computeOverallAvg([{ avg_score: 0, count: 3 }, { avg_score: 2, count: 1 }]).toFixed(4)), 0.5);
check("가중평균 빈 통계 = -1", computeOverallAvg([]), -1);
check("가중평균 [(1,2),(2,2)] = 1.5", computeOverallAvg([{ avg_score: 1, count: 2 }, { avg_score: 2, count: 2 }]), 1.5);

// ── ③ 답변 패턴 → 등급 시나리오 (flat 점수 = 발화별 채점, 평균=overallAvg) ──
interface Scn { label: string; scores: number[]; expect: string; }
const SCN: Scn[] = [
  { label: "모든 답 정확(날짜·단어3개·100-7 정답)", scores: [0, 0, 0, 0, 0, 0], expect: "정상" },
  { label: "정상 + 경계 1개(단어 2/3)", scores: [0, 0, 0, 1, 0], expect: "정상" },          // 0.2
  { label: "경계 2개 섞임(회상hedge 시간 + 동물 6개)", scores: [1, 1, 0, 0], expect: "경증" }, // 0.5
  { label: "경계 다수 + 정상", scores: [1, 1, 1, 0, 0, 0], expect: "경증" },                 // 0.5
  { label: "경계+주의 1개", scores: [1, 0, 2, 0, 0, 0], expect: "경증" },                    // 0.5
  { label: "주의 1 + 정상 다수", scores: [2, 0, 0, 0, 0], expect: "경증" },                  // 0.4
  { label: "주의 2개 + 정상 2개", scores: [2, 2, 0, 0], expect: "중증" },                    // 1.0
  { label: "주의 다수 + 경계", scores: [2, 2, 1, 0, 1], expect: "중증" },                    // 1.2
  { label: "주의 3 + 정상 2", scores: [2, 2, 2, 0, 0], expect: "중증" },                     // 1.2
  { label: "주의 3 + 경계 1(고위험 직전)", scores: [2, 2, 2, 1], expect: "고위험" },          // 1.75
  { label: "사망인물+틀린날짜+회상실패+계산오류 다발", scores: [2, 2, 2, 2], expect: "고위험" }, // 2.0
  { label: "전부 주의", scores: [2, 2, 2, 2, 2, 2], expect: "고위험" },                      // 2.0
  { label: "평가 없음", scores: [], expect: "평가전" },
];
for (const s of SCN) {
  const stats = s.scores.map((v) => ({ avg_score: v, count: 1 }));
  const avg = computeOverallAvg(stats);
  const tier = classifySeverity(avg).tier;
  check(`${s.label} [평균 ${avg < 0 ? "-" : avg.toFixed(2)}]`, tier, s.expect);
}

// ── 리포트 ──
const L: string[] = [];
L.push(`# 종합 위험도 4단계 판정 검증 — Round ${round}`);
L.push(`\n- 생성: ${new Date().toISOString()}\n- 경계: 정상<${TIER_BOUNDS.normal} · 경증<${TIER_BOUNDS.mild} · 중증<${TIER_BOUNDS.moderate} · 고위험≥${TIER_BOUNDS.moderate}\n`);
L.push("| 판정 | 케이스 | 기대 | 실제 |");
L.push("|------|--------|------|------|");
L.push(...detail);
L.push(`\n## 종합: ${pass}/${pass + fail} 통과${fail ? ` · ${fail} 실패` : ""}`);
const out = L.join("\n");
fs.writeFileSync(`docs/리포트_tier_round${round}.md`, out, "utf-8");
console.log(out);
process.exit(fail ? 1 : 0);
