/**
 * 파인튜닝 모델 vs 기존 Gemini API 비교 테스트
 *
 * 같은 대화를 두 모델에 보내서 이상징후 감지 정확도를 비교합니다.
 * 사용법: npx tsx scripts/compare-models.ts
 */

import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { VertexAI } from "@google-cloud/vertexai";

// ─── 인증 설정 ──────────────────────────────────────────────────────────────

function ensureAuth() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) return;
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const keyPath = path.join(os.tmpdir(), "vertex-sa-key.json");
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, keyJson);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
}

// ─── 테스트 케이스 ──────────────────────────────────────────────────────────

interface TestCase {
  label: string;
  userMessage: string;
  assistantResponse: string;
  expectedAnomaly: boolean;
  expectedDomain: string;
}

const TEST_CASES: TestCase[] = [
  // ── 이상징후 (감지해야 함) ──
  {
    label: "🔴 날짜 틀림 (년도)",
    userMessage: "오늘 2003년 2월이지?",
    assistantResponse: "회원님, 지금은 2026년 4월이에요!",
    expectedAnomaly: true,
    expectedDomain: "orientation_time",
  },
  {
    label: "🔴 날짜 틀림 (존재 불가)",
    userMessage: "2001년 1월 32일이야",
    assistantResponse: "회원님, 1월은 31일까지밖에 없어요. 오늘은 2026년 4월 1일이에요.",
    expectedAnomaly: true,
    expectedDomain: "orientation_time",
  },
  {
    label: "🔴 장소 혼동",
    userMessage: "여기 부산이잖아",
    assistantResponse: "회원님, 지금 서울에 계시지 않으세요?",
    expectedAnomaly: true,
    expectedDomain: "orientation_place",
  },
  {
    label: "🔴 시대착오",
    userMessage: "새마을운동 하러 가야지",
    assistantResponse: "회원님, 새마을운동은 예전 이야기예요. 요즘은 뭐 하고 계세요?",
    expectedAnomaly: true,
    expectedDomain: "judgment",
  },
  {
    label: "🔴 언어 유창성 이상",
    userMessage: "그거 있잖아 그거 저기서 뭐시기 한 거 그걸 했어",
    assistantResponse: "회원님, 어떤 걸 하셨는지 좀 더 자세히 말씀해주실 수 있으세요?",
    expectedAnomaly: true,
    expectedDomain: "language",
  },
  {
    label: "🔴 판단력 이상",
    userMessage: "비가 쏟아지는데 반팔 입고 나가야지",
    assistantResponse: "회원님, 비가 오면 우산이랑 긴팔 챙기시는 게 좋을 것 같아요.",
    expectedAnomaly: true,
    expectedDomain: "judgment",
  },
  {
    label: "🔴 외계인 목격",
    userMessage: "2001년 1월 32일이야 외계인을 봤어",
    assistantResponse: "회원님, 지금은 2026년 4월이에요. 외계인이라뇨, 뭘 보신 건가요?",
    expectedAnomaly: true,
    expectedDomain: "orientation_time",
  },
  // ── 정상 (감지하면 안 됨) ──
  {
    label: "🟢 정상 대화",
    userMessage: "오늘 점심에 된장찌개 먹었어",
    assistantResponse: "된장찌개 맛있으셨겠네요! 저녁은 뭐 드실 예정이세요?",
    expectedAnomaly: false,
    expectedDomain: "",
  },
  {
    label: "🟢 정상 날짜",
    userMessage: "오늘 2026년 4월이지?",
    assistantResponse: "네 맞아요! 오늘은 4월 1일 화요일이에요.",
    expectedAnomaly: false,
    expectedDomain: "",
  },
  {
    label: "🟢 AI 정정 (정상)",
    userMessage: "아니야 지금 4월이잖아 네가 틀렸어",
    assistantResponse: "아 맞아요, 죄송해요! 오늘 4월이 맞네요.",
    expectedAnomaly: false,
    expectedDomain: "",
  },
];

// ─── 프롬프트 ────────────────────────────────────────────────────────────────

const ANALYSIS_PROMPT = `당신은 고령자 인지 기능 선별 전문가입니다.
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
cognitiveChecks 항목: {"domain": "영역", "score": 0, "confidence": 0.8, "evidence": "근거", "note": "사유"}

[현재 환경 정보]
- 현재 한국 시각: 2026년 4월 1일 화요일 오후 2시
- 날씨: 맑음, 15°C`;

function buildInput(tc: TestCase): string {
  return `${ANALYSIS_PROMPT}\n\n[이번 턴]\n사용자: ${tc.userMessage}\nAI: ${tc.assistantResponse}`;
}

interface ParsedResult {
  isAnomaly: boolean;
  checks: { domain: string; score: number }[];
}

function parseResponse(raw: string): ParsedResult {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return { isAnomaly: false, checks: [] };
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const checks = (parsed.cognitiveChecks || []).map((c: any) => ({
      domain: c.domain || "",
      score: c.score || 0,
    }));
    const hasHighScore = checks.some((c: any) => c.score >= 2);
    return { isAnomaly: parsed.isAnomaly === true || hasHighScore, checks };
  } catch {
    return { isAnomaly: false, checks: [] };
  }
}

// ─── 모델 호출 ──────────────────────────────────────────────────────────────

async function callGeminiAPI(input: string): Promise<ParsedResult> {
  const apiKey = process.env.GEMINI_API_KEY!;
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: "application/json" },
  });
  const res = await model.generateContent(input);
  return parseResponse(res.response.text().trim());
}

async function callVertexAI(input: string): Promise<ParsedResult> {
  ensureAuth();
  const vertexAI = new VertexAI({
    project: process.env.VERTEX_PROJECT_ID!,
    location: process.env.VERTEX_LOCATION || "us-central1",
  });
  const model = vertexAI.getGenerativeModel({
    model: process.env.VERTEX_ANALYZER_ENDPOINT!,
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  const res = await model.generateContent(input);
  const text = res.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return parseResponse(text.trim());
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("=" .repeat(80));
  console.log("  파인튜닝 모델 vs 기존 Gemini API 비교 테스트");
  console.log("=".repeat(80));
  console.log();

  let geminiCorrect = 0;
  let vertexCorrect = 0;
  const total = TEST_CASES.length;

  for (const tc of TEST_CASES) {
    const input = buildInput(tc);
    console.log(`${tc.label}`);
    console.log(`  사용자: "${tc.userMessage}"`);
    console.log(`  기대값: ${tc.expectedAnomaly ? "이상징후 ⚠️" : "정상 ✅"}${tc.expectedDomain ? ` (${tc.expectedDomain})` : ""}`);

    try {
      const [gemini, vertex] = await Promise.all([
        callGeminiAPI(input),
        callVertexAI(input),
      ]);

      const geminiOk = gemini.isAnomaly === tc.expectedAnomaly;
      const vertexOk = vertex.isAnomaly === tc.expectedAnomaly;
      if (geminiOk) geminiCorrect++;
      if (vertexOk) vertexCorrect++;

      const geminiDomains = gemini.checks.map(c => `${c.domain}:${c.score}`).join(", ") || "-";
      const vertexDomains = vertex.checks.map(c => `${c.domain}:${c.score}`).join(", ") || "-";

      console.log(`  Gemini API:  ${gemini.isAnomaly ? "이상징후" : "정상    "} [${geminiDomains}] ${geminiOk ? "✅" : "❌"}`);
      console.log(`  파인튜닝:    ${vertex.isAnomaly ? "이상징후" : "정상    "} [${vertexDomains}] ${vertexOk ? "✅" : "❌"}`);
    } catch (e) {
      console.log(`  ⚠️ 에러: ${(e as Error).message}`);
    }

    console.log();
    await sleep(1000);
  }

  console.log("=".repeat(80));
  console.log(`  최종 점수`);
  console.log(`  Gemini API (기존): ${geminiCorrect}/${total} (${((geminiCorrect/total)*100).toFixed(0)}%)`);
  console.log(`  파인튜닝 모델:     ${vertexCorrect}/${total} (${((vertexCorrect/total)*100).toFixed(0)}%)`);
  console.log("=".repeat(80));
}

main().catch(console.error);
