/**
 * 파인튜닝용 시뮬레이션 데이터 생성 스크립트
 *
 * Gemini를 사용하여 6개 인지 영역별 이상/정상 대화를 대량 생성합니다.
 * 결과: training-data/simulated-chat.jsonl, training-data/simulated-analysis.jsonl
 *
 * 사용법: npx tsx scripts/generate-training-data.ts
 */

import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY가 설정되지 않았습니다.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.9, maxOutputTokens: 4096, responseMimeType: "application/json" },
});

// ─── 시나리오 정의 ──────────────────────────────────────────────────────────

interface Scenario {
  domain: string;
  type: "anomaly" | "normal";
  description: string;
  examples: string[];
}

const SCENARIOS: Scenario[] = [
  // ── 시간 지남력 (orientation_time) ──
  {
    domain: "orientation_time",
    type: "anomaly",
    description: "사용자가 현재 날짜/년도/요일을 명백히 틀리게 말함",
    examples: [
      "오늘 2003년 2월이지?",
      "지금 1998년 아닌가?",
      "오늘 월요일이잖아 (실제 수요일)",
      "지금 여름이야 (실제 3월)",
      "올해가 2019년이지?",
    ],
  },
  {
    domain: "orientation_time",
    type: "normal",
    description: "사용자가 날짜/시간에 대해 정확하게 말하거나 자연스러운 대화",
    examples: [
      "오늘 수요일 맞지?",
      "3월이니까 곧 봄이네",
      "올해 2026년이지",
      "오후 3시쯤 됐나?",
    ],
  },
  // ── 장소 지남력 (orientation_place) ──
  {
    domain: "orientation_place",
    type: "anomaly",
    description: "사용자가 현재 위치를 혼동하거나 엉뚱한 장소를 말함",
    examples: [
      "여기 부산이잖아 (실제 서울)",
      "우리집이 어딘지 모르겠어",
      "여기가 어디야? 학교인가?",
      "나 지금 회사에 있잖아 (실제 집)",
      "여긴 병원이지?",
    ],
  },
  {
    domain: "orientation_place",
    type: "normal",
    description: "사용자가 현재 위치를 정확히 인지하는 대화",
    examples: [
      "나 지금 집에 있어",
      "천안 두정동이잖아",
      "동탄 회사에서 일하고 있어",
      "마트 다녀왔어",
    ],
  },
  // ── 즉시 기억력 (memory_immediate) ──
  {
    domain: "memory_immediate",
    type: "anomaly",
    description: "방금 말한 내용을 기억하지 못하거나 반복해서 같은 말을 함",
    examples: [
      "아까 뭐라고 했지?",
      "내가 방금 뭘 먹었다고 했어?",
      "그게 뭐였더라... 방금 말했는데",
      "아까 네가 뭐라고 물어봤지?",
    ],
  },
  {
    domain: "memory_immediate",
    type: "normal",
    description: "방금 대화 내용을 정상적으로 기억하고 이어가는 대화",
    examples: [
      "아까 말한 대로 점심은 김치찌개 먹었어",
      "네가 물어본 거 대답해줄게",
      "방금 얘기한 것처럼 산책했어",
    ],
  },
  // ── 지연 기억력 (memory_delayed) ──
  {
    domain: "memory_delayed",
    type: "anomaly",
    description: "과거 대화나 경험을 기억하지 못하거나 혼동함",
    examples: [
      "어제 뭐 했는지 모르겠어",
      "지난주에 누구 만났는지 기억이 안 나",
      "아들 이름이 뭐였더라",
      "우리 며느리가 누구더라",
      "내가 어디서 일했는지 잘 모르겠어",
    ],
  },
  {
    domain: "memory_delayed",
    type: "normal",
    description: "과거 경험을 정상적으로 회상하는 대화",
    examples: [
      "어제 아들이 전화했어",
      "지난주에 병원 다녀왔는데",
      "예전에 공장에서 30년 일했지",
      "며느리가 요리를 잘해",
    ],
  },
  // ── 언어 유창성 (language) ──
  {
    domain: "language",
    type: "anomaly",
    description: "단어를 찾지 못하고 '그거', '저기', '뭐시기' 등을 과다 사용",
    examples: [
      "그거 있잖아 그거 저기서 뭐시기 한 거",
      "이름이 뭐더라 저기 그 사람",
      "그거 저거 뭐냐 저기 가서 그걸 했어",
      "말이 잘 안 나와 그게 뭐냐면",
      "어... 그... 뭐라 하지... 저기...",
    ],
  },
  {
    domain: "language",
    type: "normal",
    description: "유창하고 자연스럽게 대화하는 경우",
    examples: [
      "오늘 아침에 된장찌개 끓여서 먹었어",
      "내일은 손녀 생일이라 선물 사러 갈 거야",
      "요즘 산책하면 기분이 좋아",
      "텔레비전에서 뉴스 보는 게 재미있어",
    ],
  },
  // ── 판단력 (judgment) ──
  {
    domain: "judgment",
    type: "anomaly",
    description: "상황에 맞지 않는 판단이나 비현실적인 계획을 말함",
    examples: [
      "비가 오는데 반팔 입고 나가야지",
      "한겨울인데 수영하러 바다 갈 거야",
      "새벽 3시에 시장 가야지",
      "낯선 사람이 돈 달라고 해서 줬어",
      "가스 켜놓고 외출할 거야",
    ],
  },
  {
    domain: "judgment",
    type: "normal",
    description: "상황에 적절한 판단을 하는 대화",
    examples: [
      "비 온다니까 우산 챙겨야지",
      "추워지니까 패딩 입어야겠다",
      "아침에 시장 가서 장 볼 거야",
      "모르는 사람이 돈 달라면 안 줘야지",
    ],
  },
];

// ─── 생성 프롬프트 ──────────────────────────────────────────────────────────

function buildGenerationPrompt(scenario: Scenario, count: number): string {
  const date = "2026년 4월 1일 화요일";
  const time = "오후 2시 30분";
  const weather = "맑음, 15°C";
  const userName = "회원님";

  return `당신은 한국 고령자와 AI 손녀 '민지'의 대화 시뮬레이션 데이터 생성기입니다.

아래 조건에 맞는 대화를 ${count}개 생성하세요.

[현재 환경]
- 날짜: ${date}
- 시간: ${time}
- 날씨: ${weather}
- 사용자 호칭: ${userName}

[시나리오]
- 인지 영역: ${scenario.domain}
- 유형: ${scenario.type === "anomaly" ? "이상징후" : "정상"}
- 설명: ${scenario.description}
- 참고 예시: ${scenario.examples.join(", ")}

[대화 생성 규칙]
1. 각 대화는 2~4턴(user↔assistant 쌍)으로 구성
2. 민지는 2~3문장 이내로 따뜻하게 답변
3. 이상징후는 사용자 발화에서 자연스럽게 드러나야 함
4. 정상 대화는 일상적이고 자연스러운 내용
5. 매 대화마다 다른 상황/주제를 다루세요
6. 사용자는 60~80대 한국 노인의 말투를 사용

[JSON 출력 형식]
{
  "conversations": [
    {
      "turns": [
        {"role": "user", "content": "사용자 발화"},
        {"role": "assistant", "content": "민지 응답"}
      ],
      "analysis": {
        "isAnomaly": true/false,
        "analysisNote": "분석 설명",
        "cognitiveChecks": [
          {
            "domain": "${scenario.domain}",
            "score": 0~2,
            "confidence": 0.0~1.0,
            "evidence": "근거",
            "note": "사유"
          }
        ]
      }
    }
  ]
}

${scenario.type === "anomaly" ? "score는 반드시 2(주의)로 설정하세요." : "cognitiveChecks는 빈 배열로 설정하세요."}
${count}개 대화를 생성하세요.`;
}

// ─── 타입 ────────────────────────────────────────────────────────────────────

interface GeneratedTurn {
  role: string;
  content: string;
}

interface GeneratedConversation {
  turns: GeneratedTurn[];
  analysis: {
    isAnomaly: boolean;
    analysisNote: string;
    cognitiveChecks: {
      domain: string;
      score: number;
      confidence: number;
      evidence: string;
      note: string;
    }[];
  };
}

interface ChatRow {
  messages: { role: string; content: string }[];
}

interface AnalysisRow {
  messages: { role: string; content: string }[];
}

// ─── 시스템 프롬프트 ────────────────────────────────────────────────────────

const CHAT_SYSTEM = `당신은 '마음이음' 서비스의 AI 손녀 '민지'입니다.
사용자와 자연스럽게 대화하며, 식사 여부나 일상, 기분 등을 편하게 물어봅니다.
의료·진단·처방은 하지 말고, 참고 수준의 대화만 이어가세요.

[답변 규칙]
- 반드시 2~3문장 이내로 짧게 답하세요.
- 사용자의 말에 먼저 반응한 뒤, 자연스럽게 질문 하나를 이어가세요.
- 사용자를 호칭으로 불러주세요 (할아버지, 할머니 등).
- 응답은 자연스러운 한국어 텍스트만 출력하세요. JSON이나 기술 데이터를 절대 포함하지 마세요.`;

const ANALYSIS_SYSTEM = `당신은 고령자 인지 기능 선별 전문가입니다.
아래 대화를 분석하여 결과를 JSON으로 반환하세요.

평가 영역: orientation_time, orientation_place, memory_immediate, memory_delayed, language, judgment
점수: 0(정상), 1(경계), 2(주의)

판단 기준:
- 사용자가 날짜/월/년도/요일을 명백히 틀리게 말했으면 → isAnomaly: true, orientation_time score 2
- 사용자가 현재 날씨와 명백히 다른 말을 했으면 → isAnomaly: true
- 사용자가 AI를 정정한 경우 → isAnomaly: false (AI가 틀렸을 수 있음)
- 근거 없으면 평가하지 마세요

JSON 형식:
{"isAnomaly": false, "analysisNote": "", "cognitiveChecks": []}
cognitiveChecks 항목: {"domain": "영역", "score": 0, "confidence": 0.8, "evidence": "근거", "note": "사유"}`;

// ─── 메인 로직 ──────────────────────────────────────────────────────────────

function repairJson(raw: string): string {
  // Gemini가 대화 내용에 이스케이프 안 된 따옴표를 넣는 경우 수리
  let text = raw;
  // trailing comma 제거
  text = text.replace(/,\s*([\]}])/g, "$1");
  return text;
}

async function generateForScenario(scenario: Scenario, count: number): Promise<GeneratedConversation[]> {
  const results: GeneratedConversation[] = [];

  // 한 번에 많이 생성하면 JSON 깨짐 → 3~4개씩 나눠서 생성
  const batchSize = 3;
  const batches = Math.ceil(count / batchSize);

  for (let b = 0; b < batches; b++) {
    const batchCount = Math.min(batchSize, count - b * batchSize);
    const prompt = buildGenerationPrompt(scenario, batchCount);

    try {
      const res = await model.generateContent(prompt);
      const text = res.response.text().trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) continue;

      const jsonStr = repairJson(text.slice(start, end + 1));
      const parsed = JSON.parse(jsonStr) as { conversations?: GeneratedConversation[] };
      if (parsed.conversations) {
        results.push(...parsed.conversations);
      }
    } catch (e) {
      console.warn(`  [RETRY ${b + 1}/${batches}] JSON 파싱 실패, 재시도...`);
      // 재시도: 더 적은 수로
      try {
        const retryPrompt = buildGenerationPrompt(scenario, 2);
        const res2 = await model.generateContent(retryPrompt);
        const text2 = res2.response.text().trim();
        const s2 = text2.indexOf("{");
        const e2 = text2.lastIndexOf("}");
        if (s2 !== -1 && e2 !== -1) {
          const parsed2 = JSON.parse(repairJson(text2.slice(s2, e2 + 1))) as { conversations?: GeneratedConversation[] };
          if (parsed2.conversations) results.push(...parsed2.conversations);
        }
      } catch {
        console.warn(`  [SKIP] 재시도도 실패`);
      }
    }

    if (b < batches - 1) await sleep(1500);
  }

  return results;
}

function toTrainingRows(conversations: GeneratedConversation[]): { chatRows: ChatRow[]; analysisRows: AnalysisRow[] } {
  const chatRows: ChatRow[] = [];
  const analysisRows: AnalysisRow[] = [];

  for (const conv of conversations) {
    if (!conv.turns || conv.turns.length < 2) continue;

    // 대화 학습 데이터
    const chatMessages: { role: string; content: string }[] = [
      { role: "system", content: CHAT_SYSTEM },
    ];
    for (const turn of conv.turns) {
      chatMessages.push({
        role: turn.role === "user" ? "user" : "assistant",
        content: turn.content,
      });
    }
    chatRows.push({ messages: chatMessages });

    // 분석 학습 데이터
    const historyText = conv.turns
      .map((t) => `${t.role === "user" ? "사용자" : "AI"}: ${t.content}`)
      .join("\n");

    const lastUser = [...conv.turns].reverse().find((t) => t.role === "user");
    const lastAssistant = [...conv.turns].reverse().find((t) => t.role === "assistant");

    const analysisInput = `대화:\n${historyText}\n\n[이번 턴]\n사용자: ${lastUser?.content ?? ""}\nAI: ${lastAssistant?.content ?? ""}`;
    const analysisOutput = JSON.stringify(conv.analysis);

    analysisRows.push({
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM },
        { role: "user", content: analysisInput },
        { role: "assistant", content: analysisOutput },
      ],
    });
  }

  return { chatRows, analysisRows };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const allChatRows: ChatRow[] = [];
  const allAnalysisRows: AnalysisRow[] = [];

  let anomalyTotal = 0;
  let normalTotal = 0;

  console.log("=== 시뮬레이션 데이터 생성 시작 ===\n");

  for (const scenario of SCENARIOS) {
    const count = scenario.type === "anomaly" ? 10 : 8;
    console.log(`[${scenario.domain}/${scenario.type}] ${count}개 생성 중...`);

    const conversations = await generateForScenario(scenario, count);
    const { chatRows, analysisRows } = toTrainingRows(conversations);

    allChatRows.push(...chatRows);
    allAnalysisRows.push(...analysisRows);

    if (scenario.type === "anomaly") anomalyTotal += chatRows.length;
    else normalTotal += chatRows.length;

    console.log(`  → ${conversations.length}개 생성됨 (chat: ${chatRows.length}, analysis: ${analysisRows.length})`);

    // Rate limit 방지
    await sleep(2000);
  }

  // 파일 저장
  const outDir = path.join(process.cwd(), "training-data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const chatPath = path.join(outDir, "simulated-chat.jsonl");
  const analysisPath = path.join(outDir, "simulated-analysis.jsonl");

  fs.writeFileSync(chatPath, allChatRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(analysisPath, allAnalysisRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  console.log("\n=== 생성 완료 ===");
  console.log(`대화 학습 데이터: ${allChatRows.length}건 → ${chatPath}`);
  console.log(`분석 학습 데이터: ${allAnalysisRows.length}건 → ${analysisPath}`);
  console.log(`  - 이상징후: ${anomalyTotal}건`);
  console.log(`  - 정상: ${normalTotal}건`);
  console.log(`  - 이상 비율: ${((anomalyTotal / (anomalyTotal + normalTotal)) * 100).toFixed(1)}%`);

  // DB 추출 데이터와 합치기
  const dbChatPath = path.join(outDir, "chat-training.jsonl");
  const dbAnalysisPath = path.join(outDir, "analysis-training.jsonl");

  if (fs.existsSync(dbChatPath) && fs.existsSync(dbAnalysisPath)) {
    const mergedChatPath = path.join(outDir, "merged-chat.jsonl");
    const mergedAnalysisPath = path.join(outDir, "merged-analysis.jsonl");

    const dbChat = fs.readFileSync(dbChatPath, "utf-8").trim();
    const dbAnalysis = fs.readFileSync(dbAnalysisPath, "utf-8").trim();
    const simChat = fs.readFileSync(chatPath, "utf-8").trim();
    const simAnalysis = fs.readFileSync(analysisPath, "utf-8").trim();

    fs.writeFileSync(mergedChatPath, dbChat + "\n" + simChat + "\n");
    fs.writeFileSync(mergedAnalysisPath, dbAnalysis + "\n" + simAnalysis + "\n");

    const mergedChatCount = (dbChat + "\n" + simChat).split("\n").filter(Boolean).length;
    const mergedAnalysisCount = (dbAnalysis + "\n" + simAnalysis).split("\n").filter(Boolean).length;

    console.log(`\n=== 병합 완료 (DB + 시뮬레이션) ===`);
    console.log(`대화: ${mergedChatCount}건 → ${mergedChatPath}`);
    console.log(`분석: ${mergedAnalysisCount}건 → ${mergedAnalysisPath}`);
  }
}

main().catch((e) => {
  console.error("생성 실패:", e);
  process.exit(1);
});
