/**
 * 인지 선별 판단 엔진 자동 검증 하니스.
 *
 * 목적: 영역(domain) × 목표 점수(0 정상 / 1 경계 / 2 주의) 시나리오를 분석기(analyzeCognitive)에
 *       직접 주입하고, 실제 채점이 유도한 목표와 일치하는지 대량 측정 → 리포트(표) 생성.
 *
 * 사용:
 *   npx tsx scripts/screening-verify.ts [repeats] [round]
 *     repeats: 각 케이스 반복 횟수 (기본 3) — 분석기 temp=0.2 비결정성 측정
 *     round:  리포트 파일 라운드 번호(누적용, 기본 1)
 *
 * 출력: 콘솔 표 + docs/리포트_screening_round<round>.md
 */
import "dotenv/config";
import { analyzeCognitive } from "../lib/chat/cognitive-analyzer";
import * as fs from "fs";

const ENV = `[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]
- 현재 한국 시각: 2026년 5월 29일 금요일 오후 3시 20분
- 시간대: 오후
- 사용자 현재 위치: 경기도 화성시 동탄
- 사용자 나이: 78세 (여성)
날짜/요일/시각/위치를 말할 때는 반드시 위 정보를 사용하세요.`;

interface Case {
  id: string;
  domain: string;       // 기대 도메인
  target: 0 | 1 | 2;    // 유도 목표 점수
  history: string;      // 직전 대화 맥락 (마지막 줄에 보통 직전 AI 질문)
  user: string;         // 이번 턴 사용자 발화
  ai: string;           // 이번 턴 AI 응답
}

const REG = "AI: 민지가 단어 세 개 말씀드릴게요. 잠깐 외워보세요~ 나무, 자동차, 모자.\n사용자: 응 외웠어\nAI: 좋아요! 이따 여쭤볼게요.";

const CASES: Case[] = [
  // ── 시간 지남력 ──
  { id: "time-0", domain: "orientation_time", target: 0,
    history: "AI: 민지가 깜빡했는데 오늘 무슨 요일이에요? 달력 보기가 번거로워서요~",
    user: "오늘 금요일이지", ai: "맞아요! 금요일이에요." },
  { id: "time-2", domain: "orientation_time", target: 2,
    history: "AI: 오늘 날씨가 참 좋네요~",
    user: "그러게 근데 오늘이 2003년 3월쯤이지? 곧 봄이라 좋구만", ai: "선생님, 지금은 2026년 5월이에요." },

  // ── 장소 지남력 ──
  { id: "place-0", domain: "orientation_place", target: 0,
    history: "AI: 지금 집에 계세요, 아니면 어디 나가셨어요?",
    user: "집이지 뭐, 여기 동탄 우리집", ai: "편안한 곳에 계시네요~" },
  { id: "place-2", domain: "orientation_place", target: 2,
    history: "AI: 오후엔 뭐 하고 계세요?",
    user: "나 지금 뉴욕 한복판에 나와 있어 사람이 엄청 많아", ai: "어? 선생님 지금 동탄에 계시지 않았어요?" },

  // ── 즉시 기억 (보수적) ──
  { id: "immed-0", domain: "memory_immediate", target: 0,
    history: "AI: 민지가 단어 세 개 말씀드릴게요. 잠깐 외워보세요~ 나무, 자동차, 모자. 따라 말해보실래요?",
    user: "나무, 자동차, 모자", ai: "정확해요! 잘 외우셨어요." },

  // ── 지연 기억 ──
  { id: "delay-0", domain: "memory_delayed", target: 0,
    history: REG + "\n사용자: 오늘 점심은 김치찌개 먹었어\nAI: 맛있으셨겠어요! 아까 외워드린 단어 세 개, 기억나세요?",
    user: "나무, 자동차, 모자! 다 기억나지", ai: "우와 세 개 다 맞히셨네요!" },
  { id: "delay-1", domain: "memory_delayed", target: 1,
    history: REG + "\n사용자: 그래\nAI: 아까 외워드린 단어 세 개, 기억나세요?",
    user: "음… 나무랑 자동차… 나머지 하나는 도무지 생각이 안 나네", ai: "두 개나 기억하셨어요!" },
  { id: "delay-2", domain: "memory_delayed", target: 2,
    history: REG + "\n사용자: 응\nAI: 아까 외워드린 단어 세 개, 기억나세요?",
    user: "글쎄… 단어를 외웠었나? 하나도 기억이 안 나네", ai: "괜찮아요, 다시 해볼까요?" },

  // ── 언어 ──
  { id: "lang-0", domain: "language", target: 0,
    history: "AI: 1분 안에 동물 이름 최대한 많이 대보실래요? 민지랑 누가 많이 대나 게임해요~",
    user: "사자, 호랑이, 코끼리, 기린, 원숭이, 토끼, 강아지, 고양이, 사슴, 곰, 여우", ai: "우와 정말 많이 대셨어요!" },
  { id: "lang-2", domain: "language", target: 2,
    history: "AI: 1분 안에 동물 이름 많이 대보실래요?",
    user: "동물… 어… 그거… 그거 뭐더라… 음… 잘 생각이 안 나네", ai: "괜찮아요, 어려운 거였어요~" },
  { id: "lang-1", domain: "language", target: 1,
    history: "AI: '백문이 불여일견' 이게 무슨 뜻이에요? 갑자기 궁금해서요~",
    user: "백 번 듣는다는 말 아닌가? 그냥 백 번 들으라는 거지", ai: "아 그렇게 생각하셨군요~" },

  // ── 판단력 ──
  { id: "judg-0", domain: "judgment", target: 0,
    history: "AI: 길에서 지갑을 주우면 어떻게 하세요?",
    user: "주인 찾아주거나 안 되면 경찰서에 갖다줘야지", ai: "맞아요, 정직하시네요!" },
  { id: "judg-2", domain: "judgment", target: 2,
    history: "AI: 오늘 하루 어떠셨어요?",
    user: "어제 이순신 장군이 우리집에 차 마시러 왔다 갔어 아주 점잖더라고", ai: "선생님, 이순신 장군은 아주 오래전 분이시잖아요." },

  // ── 주의·계산 ──
  { id: "calc-0", domain: "attention_calculation", target: 0,
    history: "AI: 100에서 7을 빼면 얼마예요? 민지가 암산이 약해서~",
    user: "93이지", ai: "맞아요! 정확하세요." },
  { id: "calc-2", domain: "attention_calculation", target: 2,
    history: "AI: 100에서 7을 빼면 얼마예요?",
    user: "음… 85?", ai: "" },
  { id: "calc-2b", domain: "attention_calculation", target: 2,
    history: "AI: 오늘 뭐 하셨어요?",
    user: "어제 만원짜리 책 한 권 샀는데 거스름돈을 2만원이나 받아왔지 뭐야", ai: "" },

  // ── 경증(1) 유도 시도 — 시간/장소/판단/계산 (경계는 본래 유도가 까다로워 실측 확인용) ──
  { id: "time-1", domain: "orientation_time", target: 1,
    history: "AI: 지금 계절이 어느 쯤 같으세요?",
    user: "글쎄… 봄인가 여름인가 요즘 통 헷갈리네", ai: "" },
  { id: "place-1", domain: "orientation_place", target: 1,
    history: "AI: 지금 어느 동네 계세요?",
    user: "여기가… 우리 동네인데 동 이름이 잘 생각이 안 나네", ai: "" },
  { id: "judg-1", domain: "judgment", target: 1,
    history: "AI: 길에서 지갑을 주우면 어떻게 하세요?",
    user: "글쎄… 그냥 둘까 아니면 그냥 가져갈까 잘 모르겠네", ai: "" },
  { id: "calc-1", domain: "attention_calculation", target: 1,
    history: "AI: 100에서 7을 빼면 얼마예요?",
    user: "어… 94쯤 되나? 잘 모르겠네", ai: "" },
];

function matched(target: number, score: number | null): boolean {
  if (score === null) return false;
  if (target === 2) return score >= 2;
  return score === target;
}

async function run() {
  const repeats = parseInt(process.argv[2] || "3", 10);
  const round = process.argv[3] || "1";
  const results: Record<string, { target: number; scores: (number | null)[] }> = {};

  let n = 0;
  const total = CASES.length * repeats;
  for (const c of CASES) {
    results[c.id] = { target: c.target, scores: [] };
    for (let r = 0; r < repeats; r++) {
      n++;
      try {
        const res = await analyzeCognitive({ userMessage: c.user, assistantResponse: c.ai, historyText: c.history, envBlock: ENV });
        const chk = res.cognitiveChecks.find((x) => x.domain === c.domain);
        const score = chk ? chk.score : null;
        results[c.id].scores.push(score);
        process.stdout.write(`\r[${n}/${total}] ${c.id} rep${r + 1}: ${score === null ? "none" : score}     `);
      } catch (e) {
        results[c.id].scores.push(null);
      }
    }
  }
  process.stdout.write("\n\n");

  // 집계
  const lines: string[] = [];
  lines.push(`# 인지 선별 판단 검증 리포트 — Round ${round}`);
  lines.push("");
  lines.push(`- 생성: ${new Date().toISOString()}`);
  lines.push(`- 케이스 ${CASES.length}개 × 반복 ${repeats}회 = ${total} 분석기 호출`);
  lines.push(`- 판정: target 0/1 = 정확 일치, target 2 = score≥2 일치. 'none' = 해당 도메인 체크 미생성`);
  lines.push("");
  lines.push("| 케이스 | 영역 | 목표 | 실제 점수(반복) | 일치 | 정확도 |");
  lines.push("|--------|------|------|----------------|------|--------|");

  let totalHit = 0, totalTry = 0;
  const byDomain: Record<string, { hit: number; tot: number }> = {};
  for (const c of CASES) {
    const r = results[c.id];
    const hits = r.scores.filter((s) => matched(r.target, s)).length;
    const acc = ((hits / r.scores.length) * 100).toFixed(0);
    totalHit += hits; totalTry += r.scores.length;
    byDomain[c.domain] = byDomain[c.domain] || { hit: 0, tot: 0 };
    byDomain[c.domain].hit += hits; byDomain[c.domain].tot += r.scores.length;
    const scoreStr = r.scores.map((s) => (s === null ? "·" : s)).join(",");
    const tlabel = ["정상(0)", "경계(1)", "주의(2)"][r.target];
    lines.push(`| ${c.id} | ${c.domain} | ${tlabel} | ${scoreStr} | ${hits}/${r.scores.length} | ${acc}% |`);
  }
  lines.push("");
  lines.push("### 영역별 정확도");
  lines.push("| 영역 | 정확도 |");
  lines.push("|------|--------|");
  for (const d of Object.keys(byDomain)) {
    const b = byDomain[d];
    lines.push(`| ${d} | ${b.hit}/${b.tot} (${((b.hit / b.tot) * 100).toFixed(0)}%) |`);
  }
  lines.push("");
  // ── 항목 × 강도 매트릭스 ──
  const DOM_ORDER = ["orientation_time", "orientation_place", "memory_immediate", "memory_delayed", "language", "judgment", "attention_calculation"];
  const DOM_LABEL: Record<string, string> = {
    orientation_time: "시간 지남력", orientation_place: "장소 지남력", memory_immediate: "즉시 기억",
    memory_delayed: "지연 기억", language: "언어", judgment: "판단력", attention_calculation: "주의·계산",
  };
  const cell: Record<string, Record<number, { hit: number; tot: number }>> = {};
  for (const c of CASES) {
    const r = results[c.id];
    cell[c.domain] = cell[c.domain] || {};
    cell[c.domain][c.target] = cell[c.domain][c.target] || { hit: 0, tot: 0 };
    cell[c.domain][c.target].hit += r.scores.filter((s) => matched(c.target, s)).length;
    cell[c.domain][c.target].tot += r.scores.length;
  }
  const fmt = (d: string, t: number) => {
    const e = cell[d]?.[t];
    if (!e) return "—";
    return `${e.hit}/${e.tot} (${((e.hit / e.tot) * 100).toFixed(0)}%)`;
  };
  lines.push("### 항목 × 강도 매트릭스 (일부러 해당 강도 유도 → 그대로 채점되는지)");
  lines.push("| 인지 항목 | 정상(0) | 경증(1) | 중증(2) |");
  lines.push("|-----------|---------|---------|---------|");
  for (const d of DOM_ORDER) {
    lines.push(`| ${DOM_LABEL[d]} | ${fmt(d, 0)} | ${fmt(d, 1)} | ${fmt(d, 2)} |`);
  }
  lines.push("> '—' = 해당 강도를 자연 발화로 유도하기 어려운 칸(임상적으로 경계 단계가 모호한 영역).");
  lines.push("");
  lines.push(`### 종합 정확도: ${totalHit}/${totalTry} (${((totalHit / totalTry) * 100).toFixed(1)}%)`);
  lines.push("");
  lines.push("> 'none'(체크 미생성)이 잦은 케이스 = 분석기가 그 발화를 해당 영역 평가로 인식하지 못함 → 질문/발화 설계 보완 또는 프롬프트 보강 후보.");

  const out = lines.join("\n");
  const path = `docs/리포트_screening_round${round}.md`;
  fs.writeFileSync(path, out, "utf-8");
  console.log(out);
  console.log(`\n저장: ${path}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
