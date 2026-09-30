/**
 * 분석기 후보 모델별 '의사용 소견(analysisNote)' 품질 비교.
 *
 * 채점 정확도(matrix-verify)만으로는 부족하다 — 의사 화면에 뜨는 소견이 비어 있거나 부실하면
 * 등급은 맞아도 임상적으로 쓸모가 없다. 같은 이상 발화를 모델별로 돌려 소견을 나란히 뽑는다.
 *
 * 사용: npx tsx scripts/analyzer-note-quality.ts [model,model,...]
 */
import "dotenv/config";
import { analyzeCognitive } from "../lib/chat/cognitive-analyzer";

const MODELS = (process.argv[2] || "gemini-2.5-flash,gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.8-flash").split(",");

const ENV = `[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]
- 현재 한국 시각: 2026년 9월 30일 수요일 오후 3시
- 사용자 현재 위치: 경기도 화성시 동탄
- 사용자 나이: 70세 (남성)`;

interface Case { id: string; history: string; user: string; ai: string; expect: string }

const CASES: Case[] = [
  {
    id: "사망 배우자 현재형(judgment 2)",
    history: "사용자: 니 할머니 간지 벌써 삼년 됐다\nAI: 할머님 생각에 마음이 많이 아프시죠.",
    user: "아침에 니 할머니가 미역국 끓여줘서 먹었어. 지금 부엌에 있다",
    ai: "할머님 미역국이 참 맛있었죠. 어떤 반찬을 제일 잘 하셨어요?",
    expect: "judgment=2 · 사망 인물을 현재 생존으로 진술",
  },
  {
    id: "연도 오인(orientation_time 2)",
    history: "AI: 택배 보낼 때 적어두려는데 올해가 몇 년도였죠?",
    user: "내가 요즘 정신이 오락가락해. 올해가 몇년이더라. 천구백구십팔년인가?",
    ai: "지금은 2026년이에요.",
    expect: "orientation_time=2 · 28년 오차",
  },
  {
    id: "장소 오인(orientation_place 2)",
    history: "AI: 지금 계신 댁이 무슨 동네인지 알려주실 수 있으세요?",
    user: "여기? 여기 우리 고향 안동이지. 안동 예안면",
    ai: "지금 계신 곳은 동탄이세요.",
    expect: "orientation_place=2 · 실제 동탄인데 고향으로 오인",
  },
  {
    id: "단어 찾기 실패(language 2)",
    history: "AI: 아침에 세수하고 얼굴에 바르신 게 뭐였어요?",
    user: "그거... 얼굴에 바르는거... 아 뭐지 그 통에 든거 있잖아 그거 발랐어",
    ai: "괜찮아요, 잘 안 떠오를 때도 있죠.",
    expect: "language=2 · 이름대기 실패·대명사 과다",
  },
  {
    id: "최근 기억 실패(memory_delayed 2)",
    history: "AI: 점심은 뭐 드셨어요?",
    user: "아까 점심을 먹었는지 안먹었는지 생각이 안나네. 배는 안고픈데",
    ai: "혹시 오늘 아침은 뭘 드셨는지 기억나세요?",
    expect: "memory_delayed=2 · 당일 식사 여부 미상",
  },
  {
    id: "정상 — 사별 과거형 회상(오탐 금지)",
    history: "AI: 요즘 어떻게 지내세요?",
    user: "니 할머니가 살아있을때는 생강차를 꼭 챙겨줬는데. 벌써 삼년 됐다",
    ai: "할머님께서 참 아끼셨나 봐요.",
    expect: "전 영역 0 · 과거 회상은 정상",
  },
];

async function main() {
  for (const c of CASES) {
    console.log(`\n${"=".repeat(78)}\n■ ${c.id}\n  발화: ${c.user}\n  기대: ${c.expect}`);
    for (const m of MODELS) {
      process.env.COGNITIVE_MODEL = m;
      process.env.COGNITIVE_TWO_STAGE = "0";     // 2단 라우팅 우회 — 후보 모델 자체 성능만 본다
      const t0 = Date.now();
      try {
        const r = await analyzeCognitive({
          userMessage: c.user, assistantResponse: c.ai, historyText: c.history, envBlock: ENV,
          probeContext: true,
        });
        const checks = r.cognitiveChecks.map((x) => `${x.domain}=${x.score}`).join(", ") || "없음";
        const note = (r.analysisNote ?? "").trim();
        console.log(`\n  ── ${m} (${Date.now() - t0}ms) ${r.isAnomaly ? "🔴" : "🟢"}`);
        console.log(`     채점: ${checks}`);
        console.log(`     소견: ${note ? note : "⚠️ 비어 있음"}`);
      } catch (e) {
        console.log(`\n  ── ${m}: ⚠ ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
