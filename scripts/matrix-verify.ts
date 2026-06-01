/**
 * 항목 × 강도 정밀 매트릭스 검증 (판단 엔진 직접 호출).
 *
 * 설계 기준(MMSE-K/MoCA-K 매핑, cognitive-analyzer 프롬프트)에 맞춰
 * 각 인지 항목마다 정상(0)/경증(1)/중증(2)을 "여러 방면(변형 2~3개)"으로 유도하고,
 * 분석기가 그 강도로 채점하는지 측정 → 매트릭스 + 변형별 상세 + 실패 분석.
 *
 * 사용: npx tsx scripts/matrix-verify.ts [repeats] [round]
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

const REG = "AI: 민지가 단어 세 개 말씀드릴게요. 잠깐 외워보세요~ 나무, 자동차, 모자.\n사용자: 응 외웠어\nAI: 좋아요! 이따 여쭤볼게요.";

interface Case { domain: string; target: 0 | 1 | 2; id: string; history: string; user: string; ai: string; designed: boolean; }

const CASES: Case[] = [
  // ── 시간 지남력: 1 = 틀림 + 회상 hedge ──
  { domain: "orientation_time", target: 0, id: "time0a", designed: true, history: "AI: 민지가 깜빡했는데 오늘 무슨 요일이에요?", user: "오늘 금요일이지", ai: "맞아요!" },
  { domain: "orientation_time", target: 0, id: "time0b", designed: true, history: "AI: 이번 달이 몇 월이었죠?", user: "5월이지 5월", ai: "맞아요~" },
  { domain: "orientation_time", target: 1, id: "time1a", designed: true, history: "AI: 올해가 몇 년도이더라요~", user: "올해가… 한 2010년쯤인가? 아 옛날 생각이 자꾸 나서 헷갈리네", ai: "" },
  { domain: "orientation_time", target: 1, id: "time1b", designed: true, history: "AI: 지금 무슨 계절 같으세요?", user: "겨울인가… 예전 시골 살 때가 생각나서 그런지 가물가물하네", ai: "" },
  { domain: "orientation_time", target: 2, id: "time2a", designed: true, history: "AI: 오늘 날씨 좋네요~", user: "오늘이 2003년 3월이지? 곧 봄이라 좋구만", ai: "" },
  { domain: "orientation_time", target: 2, id: "time2b", designed: true, history: "AI: 오늘 기분 어떠세요?", user: "지금 한겨울이라 눈이 펑펑 오잖아", ai: "" },

  // ── 장소 지남력: 1 = 틀림 + 회상 hedge ──
  { domain: "orientation_place", target: 0, id: "place0a", designed: true, history: "AI: 지금 어디 계세요?", user: "집이지, 여기 동탄 우리집", ai: "" },
  { domain: "orientation_place", target: 1, id: "place1a", designed: true, history: "AI: 지금 어느 동네 계세요?", user: "여기가 부산인가… 예전에 부산 살던 생각이 자꾸 나서 헷갈리네", ai: "" },
  { domain: "orientation_place", target: 1, id: "place1b", designed: true, history: "AI: 지금 계신 곳이 어디예요?", user: "고향 시골집인가 싶기도 하고… 옛날 생각이 나서 잘 모르겠네", ai: "" },
  { domain: "orientation_place", target: 2, id: "place2a", designed: true, history: "AI: 오후엔 뭐 하세요?", user: "나 지금 뉴욕 한복판에 나와 있어 사람이 엄청 많네", ai: "" },
  { domain: "orientation_place", target: 2, id: "place2b", designed: true, history: "AI: 어디세요?", user: "여기 제주도 바닷가야 경치가 좋네", ai: "" },

  // ── 즉시 기억: 0만 설계(등록 직후 따라하기). 1/2는 설계 외 ──
  { domain: "memory_immediate", target: 0, id: "imm0a", designed: true, history: "AI: 단어 세 개 말씀드릴게요~ 나무, 자동차, 모자. 따라 해보실래요?", user: "나무, 자동차, 모자", ai: "정확해요!" },

  // ── 지연 기억: 3단어 회상 0=3개,1=2개,2=0~1개 ──
  { domain: "memory_delayed", target: 0, id: "del0a", designed: true, history: REG + "\n사용자: 점심 먹었어\nAI: 아까 외워드린 단어 세 개 기억나세요?", user: "나무, 자동차, 모자! 다 기억나지", ai: "" },
  { domain: "memory_delayed", target: 1, id: "del1a", designed: true, history: REG + "\n사용자: 그래\nAI: 아까 외워드린 단어 세 개 기억나세요?", user: "음… 나무랑 자동차… 나머지 하나는 도무지 생각이 안 나네", ai: "" },
  { domain: "memory_delayed", target: 2, id: "del2a", designed: true, history: REG + "\n사용자: 응\nAI: 아까 외워드린 단어 세 개 기억나세요?", user: "글쎄… 단어를 외웠었나? 하나도 기억이 안 나네", ai: "" },

  // ── 언어: 0=많이/이해, 1=6개/속담직역, 2=<5개/단어찾기실패 ──
  { domain: "language", target: 0, id: "lang0a", designed: true, history: "AI: 1분 안에 동물 이름 많이 대보실래요?", user: "사자, 호랑이, 코끼리, 기린, 원숭이, 토끼, 강아지, 고양이, 사슴, 곰, 여우", ai: "" },
  { domain: "language", target: 1, id: "lang1a", designed: true, history: "AI: 1분 안에 동물 이름 많이 대보실래요?", user: "사자, 호랑이, 토끼, 강아지, 고양이, 곰… 음 이 정도?", ai: "" },
  { domain: "language", target: 1, id: "lang1b", designed: true, history: "AI: '백문이 불여일견' 무슨 뜻이에요?", user: "백 번 들으라는 말이지 뭐", ai: "" },
  { domain: "language", target: 2, id: "lang2a", designed: true, history: "AI: 1분 안에 동물 이름 많이 대보실래요?", user: "동물… 어… 그거… 그거 뭐더라… 잘 생각이 안 나네", ai: "" },

  // ── 판단력: 0/2 설계(이진). 1은 설계 외 — 유도 시 0/2로 가는지 확인 ──
  { domain: "judgment", target: 0, id: "judg0a", designed: true, history: "AI: 길에서 지갑을 주우면 어떻게 하세요?", user: "주인 찾아주거나 안 되면 경찰서에 갖다줘야지", ai: "" },
  { domain: "judgment", target: 0, id: "judg0b", designed: true, history: "AI: 집에 갑자기 불이 나면 어떻게 하세요?", user: "얼른 밖으로 대피하고 119에 신고해야지", ai: "" },
  { domain: "judgment", target: 2, id: "judg2a", designed: true, history: "AI: 오늘 하루 어떠셨어요?", user: "어제 이순신 장군이 우리집에 차 마시러 왔다 갔어", ai: "" },
  { domain: "judgment", target: 2, id: "judg2b", designed: true, history: "AI: 요즘 어떻게 지내세요?", user: "다음 달에 군대 입대해야 해서 걱정이 많아", ai: "" },

  // ── 주의·계산: 0/2 설계. 1(1회 오류)은 현재 설계 모호 — 확인 ──
  { domain: "attention_calculation", target: 0, id: "calc0a", designed: true, history: "AI: 100에서 7을 빼면 얼마예요?", user: "93이지", ai: "" },
  { domain: "attention_calculation", target: 1, id: "calc1a", designed: true, history: "AI: 100에서 7씩 빼볼까요? 93 다음은요?", user: "어… 85? 아니 86인가… 헷갈리네", ai: "" },
  { domain: "attention_calculation", target: 2, id: "calc2a", designed: true, history: "AI: 100에서 7을 빼면 얼마예요?", user: "음… 85?", ai: "" },
  { domain: "attention_calculation", target: 2, id: "calc2b", designed: true, history: "AI: 오늘 뭐 하셨어요?", user: "어제 만원짜리 책 샀는데 거스름돈을 2만원이나 받아왔어", ai: "" },
];

function matched(t: number, s: number | null) { return s === null ? false : (t === 2 ? s >= 2 : s === t); }

async function run() {
  const repeats = parseInt(process.argv[2] || "3", 10);
  const round = process.argv[3] || "1";
  const res: Record<string, (number | null)[]> = {};
  let n = 0; const total = CASES.length * repeats;
  for (const c of CASES) {
    res[c.id] = [];
    for (let r = 0; r < repeats; r++) {
      n++;
      try {
        const out = await analyzeCognitive({ userMessage: c.user, assistantResponse: c.ai, historyText: c.history, envBlock: ENV });
        const chk = out.cognitiveChecks.find((x) => x.domain === c.domain);
        res[c.id].push(chk ? chk.score : null);
      } catch { res[c.id].push(null); }
      process.stdout.write(`\r[${n}/${total}] ${c.id}      `);
    }
  }
  process.stdout.write("\n");

  const DOM_ORDER = ["orientation_time", "orientation_place", "memory_immediate", "memory_delayed", "language", "judgment", "attention_calculation"];
  const LBL: Record<string, string> = { orientation_time: "시간 지남력", orientation_place: "장소 지남력", memory_immediate: "즉시 기억", memory_delayed: "지연 기억", language: "언어", judgment: "판단력", attention_calculation: "주의·계산" };
  const cell: Record<string, Record<number, { hit: number; tot: number; designed: boolean }>> = {};
  for (const c of CASES) {
    cell[c.domain] = cell[c.domain] || {};
    cell[c.domain][c.target] = cell[c.domain][c.target] || { hit: 0, tot: 0, designed: c.designed };
    cell[c.domain][c.target].hit += res[c.id].filter((s) => matched(c.target, s)).length;
    cell[c.domain][c.target].tot += res[c.id].length;
    cell[c.domain][c.target].designed = cell[c.domain][c.target].designed && c.designed;
  }
  const fmt = (d: string, t: number) => {
    const e = cell[d]?.[t]; if (!e) return "—";
    const pct = ((e.hit / e.tot) * 100).toFixed(0);
    return `${e.hit}/${e.tot} (${pct}%)${e.designed ? "" : "˙"}`;
  };

  const L: string[] = [];
  L.push(`# 항목 × 강도 정밀 매트릭스 — Round ${round}`);
  L.push(`\n- 생성: ${new Date().toISOString()} · 케이스 ${CASES.length} × 반복 ${repeats} = ${total}회`);
  L.push(`- 셀 = 일부러 그 강도로 유도 → 그 점수로 채점된 비율. \`˙\`=설계상 해당 강도 미정의(이진 항목).`);
  L.push("\n## 항목 × 강도 매트릭스");
  L.push("| 인지 항목 | 정상(0) | 경증(1) | 중증(2) |");
  L.push("|-----------|---------|---------|---------|");
  for (const d of DOM_ORDER) L.push(`| ${LBL[d]} | ${fmt(d, 0)} | ${fmt(d, 1)} | ${fmt(d, 2)} |`);
  L.push("> `—` 유도 불가 칸 · `˙` 설계상 경계 미정의(정상/주의 이진).");

  L.push("\n## 변형별 상세");
  L.push("| 케이스 | 항목 | 목표 | 점수(반복) | 일치 |");
  L.push("|--------|------|------|-----------|------|");
  let hit = 0, tot = 0;
  for (const c of CASES) {
    const sc = res[c.id]; const h = sc.filter((s) => matched(c.target, s)).length; hit += h; tot += sc.length;
    L.push(`| ${c.id} | ${LBL[c.domain]} | ${["정상", "경증", "중증"][c.target]}${c.designed ? "" : "˙"} | ${sc.map((s) => s ?? "·").join(",")} | ${h}/${sc.length} |`);
  }
  L.push(`\n## 종합: ${hit}/${tot} (${((hit / tot) * 100).toFixed(1)}%)`);
  const out = L.join("\n");
  fs.writeFileSync(`docs/리포트_matrix_round${round}.md`, out, "utf-8");
  const summary = `| ${new Date().toISOString().slice(0, 19)} | matrix(항목×강도) | ${round} | ${CASES.length}케이스 | ${hit}/${tot} (${((hit / tot) * 100).toFixed(1)}%) |\n`;
  const cum = "docs/리포트_누적.md";
  if (!fs.existsSync(cum)) fs.writeFileSync(cum, "# e2e 누적 검증 요약\n\n| 시각(UTC) | 테스트 | 라운드 | 규모 | 정확도 |\n|---|---|---|---|---|\n", "utf-8");
  fs.appendFileSync(cum, summary, "utf-8");
  console.log(out);
}
run().catch((e) => { console.error(e); process.exit(1); });
