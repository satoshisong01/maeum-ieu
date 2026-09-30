/**
 * 대화 1턴 도구 — 실제 앱 경로로 한 턴을 주고받고, 여러 분석기 모델의 판단을 동시에 보여준다.
 * 스크립트가 아닌 '실제 적응형 대화'용: 응답을 보고 다음 발화를 사람이 정한다.
 * (테스트는 텍스트로 진행 — 제품의 음성 전용 UX와 무관하게 동일한 LLM 경로를 탄다.)
 *
 * 사용:
 *   npx tsx scripts/chat-turn.ts --reset                 세션 초기화
 *   npx tsx scripts/chat-turn.ts "오늘 날씨 좋네"          한 턴 진행
 *   npx tsx scripts/chat-turn.ts --models a,b "발화"      분석기 모델 지정
 *   npx tsx scripts/chat-turn.ts --stats                 누적 토큰/비용 요약
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../lib/prisma";
import { buildSystemPrompt } from "../lib/chat/prompt";
import { getTextModel } from "../lib/chat/llm";
import { getTimeContext } from "../lib/chat/time";
import { analyzeCognitive } from "../lib/chat/cognitive-analyzer";
import { postProcessReply } from "../lib/chat/postprocess";
import { costOf, priceLabel, PRICES } from "./model-prices";

const STATE = path.join(process.cwd(), "docs", ".chat-session.json");
/** 운영 기본값과 일치 — 분석기 정밀 채점 모델(2단 라우팅의 lite는 자동으로 2.5-flash) */
const DEFAULT_MODELS = ["gemini-3.8-flash"];

interface Tok { in: number; out: number; cached: number; calls: number }
interface State {
  userId: string;
  conversationId: string;
  hist: { role: string; parts: { text: string }[] }[];
  historyText: string;
  turn: number;
  /** 동반자도 모델별 분리 — 수다 턴 2.5 / 확인 턴 3.8로 단가가 다르다 */
  chat: Record<string, Tok>;
  /** 설정(COGNITIVE_MODEL) → 실제 호출된 단계 모델 → 토큰. 2단 라우팅의 lite 콜은 lite 단가로 계산해야 함 */
  ana: Record<string, Record<string, Tok>>;
  /** 확인 턴 수 — 실측 비율(설계 20%)과 분석기 정밀 채점 비율 검증용 */
  probeTurns: number;
}

const zero = (): Tok => ({ in: 0, out: 0, cached: 0, calls: 0 });
/** 캐시 적중분은 입력가의 10%만 과금 — 무시하면 과대 계상 */
const cost = (t: Tok, model: string, future = false): number => costOf(model, t.in, t.out, future, t.cached);

/** 실제 앱과 동일하게 매 턴 프롬프트를 새로 만든다 — 5턴마다 도는 '인지 확인' 턴이 정상 발동하도록 */
async function buildPrompt(userId: string, conversationId: string) {
  return buildSystemPrompt({
    userId,
    conversationId,
    timeCtx: getTimeContext(),
    weather: { description: "맑음", location: "동탄", promptText: "현재 위치 동탄, 맑음 22도" } as never,
    mode: "user",
  });
}

/**
 * 적응형 대화 전용 계정 — Play 심사용 데모 계정(test1234@test.com)은 절대 건드리지 않는다.
 * probe-compliance.ts(modeltest@)와 분리 — 같은 대화를 쓰면 턴 인덱스가 서로 오염된다.
 */
const TEST_EMAIL = "convtest@maeum.test";

async function freshState(): Promise<State> {
  const user = await prisma.user.upsert({
    where: { email: TEST_EMAIL },
    update: {},
    create: {
      email: TEST_EMAIL, name: "김순자", age: 70, gender: "male",
      companionName: "민지", companionRelation: "손녀", screeningMode: "user",
      consentedAt: new Date(), consentVersion: "test",
    },
    select: { id: true },
  });
  const conv = await prisma.conversation.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, title: "모델 비교 테스트" },
    select: { id: true },
  });
  const del = await prisma.message.deleteMany({ where: { conversationId: conv.id } });
  console.log(`테스트 계정 준비 (기존 메시지 ${del.count}건 정리)`);
  return { userId: user.id, conversationId: conv.id, hist: [], historyText: "", turn: 0, chat: {}, ana: {}, probeTurns: 0 };
}

/** logUsage의 `[usage] label model=... input=N output=N thinking=N cached=N` 라인을 가로채 누적 */
function captureUsage(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const s = args.map(String).join(" ");
    if (s.startsWith("[usage]")) { lines.push(s); return; }
    orig(...(args as []));
  };
  return { lines, restore: () => { console.log = orig; } };
}

function parseUsage(line: string): { label: string; model: string; t: Tok } | null {
  const m = /^\[usage\] (\S+) model=(\S+) input=(\d+) output=(\d+) thinking=(\d+) cached=(\d+)/.exec(line);
  if (!m) return null;
  return {
    label: m[1], model: m[2],
    t: { in: +m[3], out: +m[4] + +m[5], cached: +m[6], calls: 1 },
  };
}

function addTok(dst: Tok, src: Tok): void {
  dst.in += src.in; dst.out += src.out; dst.cached += src.cached; dst.calls += src.calls;
}

async function main() {
  process.env.DEBUG_USAGE = "1";
  const argv = process.argv.slice(2);
  let models = DEFAULT_MODELS;
  const mi = argv.indexOf("--models");
  if (mi >= 0) { models = argv[mi + 1].split(",").map((s) => s.trim()).filter(Boolean); argv.splice(mi, 2); }

  if (argv.includes("--reset")) {
    const st = await freshState();
    fs.writeFileSync(STATE, JSON.stringify(st), "utf-8");
    console.log("세션 초기화 완료");
    return;
  }
  if (!fs.existsSync(STATE)) { console.log("세션 없음 — 먼저 --reset"); return; }
  const st: State = JSON.parse(fs.readFileSync(STATE, "utf-8"));

  if (argv.includes("--stats")) {
    const n = Math.max(st.turn, 1);
    console.log(`\n=== ${st.turn}턴 누적 (확인 턴 ${st.probeTurns}회 = ${Math.round((st.probeTurns / n) * 100)}%) ===`);
    console.log(`캐시 적중 입력은 입력가의 10%만 과금(90% 할인) — 반영됨\n`);

    let chatCost = 0, chatCost27 = 0;
    console.log("동반자:");
    for (const [m, t] of Object.entries(st.chat)) {
      const c = cost(t, m), c27 = cost(t, m, true);
      chatCost += c; chatCost27 += c27;
      const hit = t.in ? Math.round((t.cached / t.in) * 100) : 0;
      console.log(`   └ ${m}: ${t.calls}회 · 입력 ${t.in.toLocaleString()}(캐시 ${t.cached.toLocaleString()} = ${hit}%) · 출력 ${t.out.toLocaleString()} → $${c.toFixed(4)}${c27 !== c ? ` (2027 $${c27.toFixed(4)})` : ""}`);
    }
    console.log(`   = $${chatCost.toFixed(4)}`);

    const anaCost: Record<string, number> = {}, anaCost27: Record<string, number> = {};
    for (const [cfg, stages] of Object.entries(st.ana)) {
      let sum = 0, sum27 = 0;
      console.log(`분석기 설정 ${cfg}:`);
      for (const [sm, t] of Object.entries(stages)) {
        const c = cost(t, sm), c27 = cost(t, sm, true);
        sum += c; sum27 += c27;
        console.log(`   └ ${sm}: ${t.calls}회 · 입력 ${t.in.toLocaleString()}(캐시 ${t.cached.toLocaleString()}) · 출력 ${t.out.toLocaleString()} → $${c.toFixed(4)}`);
      }
      anaCost[cfg] = sum; anaCost27[cfg] = sum27;
      console.log(`   = $${sum.toFixed(4)} · 정밀채점 비율 ${Math.round(((stages["gemini-3.8-flash"]?.calls ?? stages["gemini-3.5-flash"]?.calls ?? 0) / n) * 100)}%`);
    }

    console.log(`\n턴당 동반자: $${(chatCost / n).toFixed(5)}`);
    for (const [cfg, c] of Object.entries(anaCost)) {
      const tot = (chatCost + c) / n, tot27 = (chatCost27 + anaCost27[cfg]) / n;
      console.log(`턴당 분석기 ${cfg}: $${(c / n).toFixed(5)}  → 합계 $${tot.toFixed(5)} (${Math.round(tot * 1400)}원)${tot27 !== tot ? ` · 2027 $${tot27.toFixed(5)} (${Math.round(tot27 * 1400)}원)` : ""}`);
      console.log(`   하루 10턴 월 $${(tot * 300).toFixed(2)} · 20턴 월 $${(tot * 600).toFixed(2)} · 30턴 월 $${(tot * 900).toFixed(2)}`);
    }
    console.log(`\n단가: ${[...Object.keys(st.chat), ...Object.keys(st.ana).flatMap((c) => Object.keys(st.ana[c]))].filter((v, i, a) => a.indexOf(v) === i).map((m) => `${m} ${priceLabel(m)}`).join(" · ")}`);
    return;
  }

  // 이번 턴이 수다/확인 중 무엇인지, 확인이면 어떤 영역·후보 질문이 주입되는지 미리 본다(호출 없음)
  if (argv.includes("--inspect")) {
    const p = await buildPrompt(st.userId, st.conversationId);
    const m = /\n\[사용자 모드 —[\s\S]*?(?=\n\n\[|$)/.exec(p.systemPrompt);
    console.log(`다음 턴: ${st.turn + 1}턴 · 총 ${p.systemPrompt.length}자`);
    console.log(m ? m[0] : "(가이드 블록 미검출)");
    return;
  }

  const utter = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!utter) { console.log('발화 필요. 예: npx tsx scripts/chat-turn.ts "오늘 날씨 좋네"'); return; }

  // 0) 앱과 동일하게 이번 턴 프롬프트를 새로 생성 — 5턴마다 '인지 확인' 턴이 발동함
  const p = await buildPrompt(st.userId, st.conversationId);
  const probing = /인지 확인을 슬쩍/.test(p.systemPrompt);

  // 1) 동반자 응답 (앱과 동일: 2.5-flash, thinkingBudget 512, 검색 off)
  const cap = captureUsage();
  const model = getTextModel(p.systemPrompt, false, undefined, p.probeTurn);
  st.hist.push({ role: "user", parts: [{ text: utter }] });
  const res = await model.generateContent({ contents: st.hist });
  cap.restore();
  const raw = ((res as unknown as { text?: string }).text ?? "").trim();
  // 운영과 동일한 후처리 14단을 태운다 — 어르신이 실제로 보고 듣는 문장으로 평가하기 위함
  //   (미적용 시 마크다운 별표·호칭 오류 등이 남아 결함을 오판하게 됨)
  const prevAi = [...st.hist].reverse().find((h) => h.role === "model")?.parts[0].text ?? "";
  const processed = postProcessReply(raw, {
    userText: utter, companionName: p.companionName, ctx: st.historyText,
    honorific: p.honorific, family: p.profile.family, prevAi,
  });
  const reply = processed.trim() || raw;   // 후처리가 통째로 비우면 원문 사용(운영 호출부와 동일 가드)
  const u = (res as unknown as { usageMetadata?: Record<string, number> }).usageMetadata ?? {};
  // 실제 응답한 모델명으로 적재 — 확인 턴은 상향 모델이라 단가가 다르다
  const usedModel = (res as unknown as { modelVersion?: string }).modelVersion
    || (p.probeTurn ? (process.env.COMPANION_PROBE_MODEL || "gemini-3.8-flash") : (process.env.COMPANION_MODEL || "gemini-2.5-flash"));
  st.chat[usedModel] ??= zero();
  addTok(st.chat[usedModel], {
    in: u.promptTokenCount ?? 0,
    out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cached: u.cachedContentTokenCount ?? 0, calls: 1,
  });
  st.hist.push({ role: "model", parts: [{ text: reply }] });
  st.turn++;
  if (p.probeTurn) st.probeTurns++;

  // 앱과 동일하게 DB에 기록 — 이 카운트가 다음 턴의 수다/확인 비율(5턴마다)을 정한다
  await prisma.message.createMany({
    data: [
      { conversationId: st.conversationId, role: "user", content: utter },
      { conversationId: st.conversationId, role: "assistant", content: reply },
    ],
  });

  console.log(`\n━━━━━ ${st.turn}턴 ${probing ? "[인지 확인 턴]" : "[수다 턴]"} ━━━━━`);
  console.log(`👤 ${utter}`);
  console.log(`🤖 ${reply}`);
  const mv = (res as unknown as { modelVersion?: string }).modelVersion ?? "?";
  console.log(`   (${mv} · 입력 ${(u.promptTokenCount ?? 0).toLocaleString()} / 출력 ${((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)).toLocaleString()})\n`);

  // 2) 같은 발화·같은 맥락으로 모델별 판단
  for (const m of models) {
    process.env.COGNITIVE_MODEL = m;
    const c = captureUsage();
    const t0 = Date.now();
    let out = "";
    try {
      const j = await analyzeCognitive({
        userMessage: utter, assistantResponse: reply,
        historyText: st.historyText, envBlock: p.envBlock,
        probeContext: p.probeTurn || p.prevProbeTurn,
        answeringProbe: p.prevProbeTurn,
      });
      const cs = (j.cognitiveChecks ?? []) as { domain: string; score: number }[];
      const mx = cs.length ? Math.max(...cs.map((x) => x.score)) : 0;
      const flag = j.isAnomaly || mx >= 2 ? "🔴 이상" : mx >= 1 ? "🟡 경미" : "🟢 정상";
      out = `  ${flag}  ${m}  (${Date.now() - t0}ms)`;
      if (cs.length) out += `\n     채점: ${cs.map((x) => `${x.domain}=${x.score}`).join(", ")}`;
      if (j.analysisNote) out += `\n     근거: ${j.analysisNote.slice(0, 140)}`;
    } catch (e) {
      out = `  ⚠ ${m} 실패: ${e instanceof Error ? e.message : String(e)}`;
    }
    c.restore();
    // 이 모델이 실제로 쓴 토큰 — 2단 라우팅이면 lite+primary 두 줄이 잡힌다
    const stages: string[] = [];
    for (const line of c.lines) {
      const pu = parseUsage(line);
      if (!pu) continue;
      // modelVersion(예: gemini-2.5-flash)을 그대로 단계 키로 — 단가를 단계별 실제 모델로 계산
      const stageModel = PRICES[pu.model] ? pu.model : (pu.label === "analyzer-lite" ? "gemini-2.5-flash" : m);
      st.ana[m] ??= {};
      st.ana[m][stageModel] ??= zero();
      addTok(st.ana[m][stageModel], pu.t);
      stages.push(`${pu.label}(${pu.model}) in=${pu.t.in} out=${pu.t.out}`);
    }
    console.log(out);
    if (stages.length) console.log(`     토큰: ${stages.join(" | ")}`);
  }

  st.historyText += `사용자: ${utter}\nAI: ${reply}\n`;
  fs.writeFileSync(STATE, JSON.stringify(st), "utf-8");
}

main()
  .catch((e) => { console.error("FAIL:", e instanceof Error ? e.stack : e); process.exit(1); })
  .finally(() => prisma.$disconnect());
