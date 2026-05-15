// reclassifyCalculation 검증
// 시나리오: AI가 계산 질문 → 사용자 숫자 답 → LLM이 memory_delayed 오판 → attention_calculation 재배정

type Check = { domain: string; score: number; confidence: number; evidence: string; note: string };
type Result = { isAnomaly: boolean; analysisNote: string; cognitiveChecks: Check[] };

const CALC_QUESTION_PATTERN = /(?:\d+\s*(?:에서|-)\s*\d+\s*(?:을|를)?\s*(?:빼|더|곱|나눠|나누))|(?:\d+\s*[+\-*×÷]\s*\d+)|(?:거스름돈|얼마|몇|덧셈|뺄셈|곱셈|나눗셈|계산)/;
const NUMERIC_REPLY_PATTERN = /^\s*(?:\d+|[영일이삼사오육칠팔구십백천만\s]+)\s*(?:원|개|살|세|점|등)?\s*[.!?~]?\s*$/;

function extractLastAiMessage(historyText: string): string {
  const lines = historyText.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:AI|assistant|Assistant|민지|ai)\s*[:：]\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

function reclassifyCalculation(result: Result, userMessage: string, historyText: string): Result {
  const lastAi = extractLastAiMessage(historyText);
  if (!lastAi || !CALC_QUESTION_PATTERN.test(lastAi)) return result;
  const userOnlyNumber = NUMERIC_REPLY_PATTERN.test(userMessage) && /[\d일이삼사오육칠팔구십]/.test(userMessage);
  if (!userOnlyNumber) return result;
  const misclassified = result.cognitiveChecks.filter((c) => (c.domain === "memory_delayed" || c.domain === "memory_immediate") && c.score >= 1);
  if (misclassified.length === 0) return result;
  const hasCalc = result.cognitiveChecks.some((c) => c.domain === "attention_calculation");
  let newChecks = result.cognitiveChecks.filter((c) => c.domain !== "memory_delayed" && c.domain !== "memory_immediate");
  if (!hasCalc) {
    const worstScore = Math.max(...misclassified.map((c) => c.score));
    newChecks = [
      ...newChecks,
      { domain: "attention_calculation", score: worstScore, confidence: 0.7,
        evidence: `직전 AI 계산 질문에 숫자 답("${userMessage.slice(0, 40)}") 오분류 보정`,
        note: "memory→attention_calculation 재배정" },
    ];
  }
  return {
    ...result,
    cognitiveChecks: newChecks,
    analysisNote: result.analysisNote.replace(/(?:연세|나이|생년).*?(?:불일치|틀림|차이)/g, "계산 영역 재배정").slice(0, 500),
  };
}

let pass = 0, fail = 0;
function assert(cond: boolean, label: string, ctx?: unknown) {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}`); if (ctx) console.log("  ctx:", JSON.stringify(ctx)); fail++; }
}

// Case 1: 핵심 회귀 — AI "79에서 7 빼면?" 사용자 "70" → memory_delayed → attention_calculation 재배정
{
  const r = reclassifyCalculation(
    { isAnomaly: true, analysisNote: "79세→70세 연세 정보 불일치", cognitiveChecks: [
      { domain: "memory_delayed", score: 2, confidence: 0.6, evidence: "70 응답", note: "나이 불일치" },
    ]},
    "70",
    "사용자: 안녕하세요\nAI: 안녕하세요 할아버지!\n사용자: 점심 먹었어\nAI: 79에서 7을 빼면 얼마예요?",
  );
  assert(r.cognitiveChecks.some((c) => c.domain === "attention_calculation" && c.score === 2), "memory_delayed → attention_calculation 재배정", r);
  assert(!r.cognitiveChecks.some((c) => c.domain === "memory_delayed"), "기존 memory_delayed 제거됨", r);
  assert(!r.analysisNote.includes("연세 정보 불일치"), "오판 note 정리됨", r.analysisNote);
}

// Case 2: AI 계산 질문이 아니면 건드리지 않음
{
  const r = reclassifyCalculation(
    { isAnomaly: true, analysisNote: "가족 이름 기억 못함", cognitiveChecks: [
      { domain: "memory_delayed", score: 2, confidence: 0.8, evidence: "아들 이름 답 못함", note: "지연 기억 저하" },
    ]},
    "70",
    "사용자: 손주 어디 사는지 기억나세요\nAI: 아드님 성함이 뭐였더라요?",
  );
  assert(r.cognitiveChecks.some((c) => c.domain === "memory_delayed"), "계산 질문 아닐 때 memory_delayed 유지", r);
  assert(!r.cognitiveChecks.some((c) => c.domain === "attention_calculation"), "attention_calculation 안 추가됨", r);
}

// Case 3: 사용자 답이 숫자가 아니면 건드리지 않음
{
  const r = reclassifyCalculation(
    { isAnomaly: true, analysisNote: "", cognitiveChecks: [
      { domain: "memory_delayed", score: 2, confidence: 0.6, evidence: "", note: "" },
    ]},
    "기억이 안 나요",
    "AI: 100에서 7 빼면 얼마예요?",
  );
  assert(r.cognitiveChecks.some((c) => c.domain === "memory_delayed"), "숫자 답 아닐 때 그대로", r);
}

// Case 4: 거스름돈 질문 패턴도 인식
{
  const r = reclassifyCalculation(
    { isAnomaly: true, analysisNote: "", cognitiveChecks: [
      { domain: "memory_delayed", score: 2, confidence: 0.6, evidence: "3천원 답", note: "" },
    ]},
    "삼천원",
    "AI: 만원 내면 거스름돈은 얼마일까요?",
  );
  assert(r.cognitiveChecks.some((c) => c.domain === "attention_calculation"), "거스름돈 패턴 인식", r);
}

// Case 5: 이미 attention_calculation 있으면 추가하지 않음
{
  const r = reclassifyCalculation(
    { isAnomaly: true, analysisNote: "", cognitiveChecks: [
      { domain: "memory_delayed", score: 2, confidence: 0.6, evidence: "", note: "" },
      { domain: "attention_calculation", score: 1, confidence: 0.7, evidence: "기존", note: "기존" },
    ]},
    "70",
    "AI: 79에서 7 빼면?",
  );
  const calcChecks = r.cognitiveChecks.filter((c) => c.domain === "attention_calculation");
  assert(calcChecks.length === 1, "기존 attention_calculation 한 개만 유지", r);
  assert(calcChecks[0].evidence === "기존", "기존 attention_calculation 보존", r);
  assert(!r.cognitiveChecks.some((c) => c.domain === "memory_delayed"), "memory_delayed는 그래도 제거", r);
}

// Case 6: AI 메시지가 history에 없으면 noop
{
  const r = reclassifyCalculation(
    { isAnomaly: false, analysisNote: "", cognitiveChecks: [] },
    "70",
    "",
  );
  assert(r.cognitiveChecks.length === 0, "빈 history → noop");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
