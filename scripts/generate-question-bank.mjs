/**
 * 사용자모드 질문 풀 생성 (1회 실행) — 항목(item-type)별 100개 변형을 미리 만들어 정적 파일로 저장.
 * 런타임 생성 X. 표준 도구(MMSE-K/MoCA-K/KDSQ-C + 해외 MMSE/MoCA/AD8/유창성)를 기초로
 * 일상 대화에서 자연스럽게 물을 수 있는 "비슷하지만 서로 다른" 질문을 생성.
 *
 * 사용: GEMINI_API_KEY 설정 후  node scripts/generate-question-bank.mjs
 *       (특정 항목만:  node scripts/generate-question-bank.mjs orientation_time:year )
 * 출력: lib/screening/question-bank.json  (증분 저장 — 중단해도 진행분 보존, 재실행 시 이어서)
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

const MODEL = process.env.COGNITIVE_MODEL || "gemini-3.5-flash";
const TARGET = 100;          // 항목당 목표 개수
const OUT = "lib/screening/question-bank.json";
const onlyFilter = process.argv[2] || null; // "domain:itemType" 또는 "domain"

// ── 항목 taxonomy (국내+해외 표준 도구 기반, 음성으로 시행 가능한 항목만) ──
const ITEMS = [
  // 시간 지남력
  { domain: "orientation_time", itemType: "year", source: "MMSE-K/MoCA", measure: "올해 연도 인지", examples: ["올해가 몇 년도예요?", "지금이 몇 년도인지 아세요?"] },
  { domain: "orientation_time", itemType: "month", source: "MMSE-K", measure: "현재 월 인지", examples: ["지금 몇 월이에요?", "이번 달이 몇 월이죠?"] },
  { domain: "orientation_time", itemType: "day_date", source: "MMSE-K", measure: "오늘 날짜 인지", examples: ["오늘이 며칠이에요?", "오늘 날짜가 어떻게 되죠?"] },
  { domain: "orientation_time", itemType: "weekday", source: "MMSE-K", measure: "요일 인지", examples: ["오늘이 무슨 요일이에요?", "오늘 무슨 요일인지 아세요?"] },
  { domain: "orientation_time", itemType: "season", source: "MMSE-K", measure: "계절 인지", examples: ["지금이 무슨 계절이에요?", "요즘이 어느 계절 같으세요?"] },
  // 장소 지남력
  { domain: "orientation_place", itemType: "province_city", source: "MMSE-K/MMSE", measure: "현재 시/도 인지", examples: ["여기가 무슨 시·도예요?", "지금 계신 곳이 어느 지역이에요?"] },
  { domain: "orientation_place", itemType: "neighborhood", source: "MMSE-K", measure: "현재 동네/지역 인지", examples: ["여기가 무슨 동네예요?", "지금 어느 동네에 계세요?"] },
  { domain: "orientation_place", itemType: "place_type", source: "MMSE-K/MMSE", measure: "현재 장소 종류 인지(집/병원 등)", examples: ["지금 계신 곳이 어디예요? 집인가요?", "여기가 어떤 곳이에요?"] },
  // 즉시 기억
  { domain: "memory_immediate", itemType: "three_words_register", source: "MMSE-K/MMSE", measure: "단어 3개 등록(따라말하기)", examples: ["단어 세 개 불러드릴게요. 따라 해보세요. 나무, 자동차, 모자.", "지금 세 단어 말씀드릴게요. 기차, 사과, 우산. 따라 해보실래요?"] },
  { domain: "memory_immediate", itemType: "sentence_repeat_now", source: "MoCA", measure: "문장 즉시 따라말하기", examples: ["제가 하는 말을 그대로 따라 해보세요. ‘오늘 날씨가 참 맑고 좋다.’", "이 문장 따라 해보실래요? ‘시장에 가면 사람이 많다.’"] },
  // 지연 기억
  { domain: "memory_delayed", itemType: "three_words_recall", source: "MMSE-K/MMSE", measure: "조금 전 외운 단어 3개 회상", examples: ["아까 외워두시라고 한 단어 세 개 기억나세요?", "조금 전에 말씀드린 세 단어가 뭐였죠?"] },
  { domain: "memory_delayed", itemType: "recent_event", source: "KDSQ-C/AD8", measure: "최근 사건(식사/방문 등) 회상", examples: ["오늘 점심에 뭐 드셨어요?", "어제 누가 다녀가셨다고 했죠?"] },
  // 주의·계산
  { domain: "attention_calculation", itemType: "serial_seven", source: "MMSE-K/MMSE", measure: "100에서 7씩 빼기", examples: ["100에서 7을 빼면 얼마예요?", "100에서 7씩 계속 빼볼까요?"] },
  { domain: "attention_calculation", itemType: "making_change", source: "KDSQ-C", measure: "거스름돈 계산", examples: ["만 원 내고 삼천 원짜리 사면 거스름돈 얼마예요?", "오천 원짜리 사고 만 원 내면 얼마 돌려받죠?"] },
  { domain: "attention_calculation", itemType: "reverse_span", source: "MMSE-K/MoCA", measure: "거꾸로 말하기(단어/숫자 역순)", examples: ["‘삼천리강산’을 거꾸로 말해보세요.", "제가 부르는 숫자를 거꾸로 말해보세요. 2-7-4."] },
  { domain: "attention_calculation", itemType: "simple_arithmetic", source: "일상 계산", measure: "일상 맥락 간단 암산", examples: ["사과 세 개에 한 개 천 원이면 모두 얼마예요?", "한 봉지에 두 개씩 세 봉지면 모두 몇 개죠?"] },
  // 언어
  { domain: "language", itemType: "category_fluency", source: "MoCA/CERAD", measure: "범주 유창성(동물·과일·가게 물건)", examples: ["1분 동안 동물 이름 최대한 많이 말해보세요.", "생각나는 과일 이름 쭉 말해볼까요?"] },
  { domain: "language", itemType: "letter_fluency", source: "COWAT/음소유창성", measure: "음소 유창성(특정 글자 시작 단어)", examples: ["‘ㄱ’으로 시작하는 단어 많이 말해보세요.", "‘ㅅ’으로 시작하는 말 생각나는 대로 해보실래요?"] },
  { domain: "language", itemType: "proverb_meaning", source: "MMSE-K/추상", measure: "속담 의미 이해", examples: ["‘백문이 불여일견’이 무슨 뜻이에요?", "‘가는 말이 고와야 오는 말이 곱다’가 무슨 뜻일까요?"] },
  { domain: "language", itemType: "sentence_repeat_lang", source: "MMSE-K", measure: "따라말하기(조음·언어)", examples: ["‘간장 공장 공장장’ 따라 해보세요.", "‘저기 저 분이 박 법학박사이시다’ 따라 해보실래요?"] },
  { domain: "language", itemType: "naming", source: "MMSE/MoCA", measure: "물건 이름대기(묘사→이름)", examples: ["시간 보는 데 쓰고 손목에 차는 거, 뭐라고 하죠?", "글씨 쓸 때 쓰는 검은 심 든 거 이름이 뭐예요?"] },
  // 판단력
  { domain: "judgment", itemType: "situation_judgment", source: "MMSE-K/KDSQ-C", measure: "상황 판단", examples: ["길에서 남의 지갑을 주우면 어떻게 하시겠어요?", "집에 갑자기 불이 나면 어떻게 하실 거예요?"] },
  { domain: "judgment", itemType: "abstraction", source: "MoCA", measure: "추상적 사고(공통점)", examples: ["기차와 자전거의 공통점이 뭘까요?", "사과와 바나나는 어떤 점이 닮았죠?"] },
];

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    questions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text: { type: SchemaType.STRING, description: "어르신에게 자연스럽게 물을 한국어 질문 한 문장" },
          hint: { type: SchemaType.STRING, description: "기대 답변/채점 단서(짧게)" },
        },
        required: ["text", "hint"],
      },
    },
  },
  required: ["questions"],
};

function buildPrompt(item, existing) {
  return `당신은 30년 경력의 노인 인지선별 전문가입니다. 아래 "인지선별 항목"을 측정하는, 어르신과의 일상 대화에서 자연스럽게 물을 수 있는 한국어 질문을 다양하게 만들어 주세요.

[항목] ${item.domain} / ${item.itemType}
[측정 목적] ${item.measure}
[표준 도구 근거] ${item.source} (국내+해외 표준을 폭넓게 참고)
[예시(이 느낌으로, 그러나 표현을 다양화)]
${item.examples.map((e) => "- " + e).join("\n")}

[요구사항]
- 같은 항목을 측정하되 **표현·말투·맥락을 최대한 다양하게**(존댓말, 다정한 손주 말투, 다른 도입 등). 단순 어미 변형 말고 실제로 다른 질문.
- 어르신이 위협감 느끼지 않게 부드럽고 짧게. 한 문장 위주.
- 정답을 질문 안에 노출하지 말 것(회상/계산 항목 특히).
- 한 번에 60개 생성. 아래 "이미 만든 질문"과 의미상 중복되지 않게.
${existing.length ? `[이미 만든 질문(중복 금지)]\n${existing.slice(-40).map((t) => "- " + t).join("\n")}` : ""}

JSON으로만 반환: { "questions": [ { "text": "...", "hint": "..." }, ... ] }`;
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: MODEL,
  generationConfig: { temperature: 1.0, maxOutputTokens: 8192, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
});

function norm(s) { return s.toLowerCase().replace(/[\s\p{P}]/gu, ""); }

async function genForItem(item) {
  const out = [];
  const seen = new Set();
  let attempts = 0;
  while (out.length < TARGET && attempts < 4) {
    attempts++;
    let res;
    try { res = await model.generateContent(buildPrompt(item, out.map((q) => q.text))); }
    catch (e) { console.warn(`  ! ${item.itemType} attempt ${attempts} err: ${e.message?.slice(0, 80)}`); await new Promise((r) => setTimeout(r, 1500)); continue; }
    let parsed;
    try { parsed = JSON.parse(res.response.text()); } catch { continue; }
    for (const q of parsed.questions || []) {
      if (!q?.text) continue;
      const k = norm(q.text);
      if (k.length < 4 || seen.has(k)) continue;
      seen.add(k);
      out.push({ text: q.text.trim(), hint: (q.hint || "").trim() });
      if (out.length >= TARGET) break;
    }
    process.stdout.write(`\r  ${item.domain}/${item.itemType}: ${out.length}/${TARGET} (시도 ${attempts})   `);
  }
  return out.slice(0, TARGET);
}

function load() { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return { generatedAt: "", model: MODEL, items: {} }; } }
function save(bank) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(bank, null, 2), "utf8"); }

(async () => {
  if (!process.env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY 필요"); process.exit(1); }
  const bank = load();
  const targets = ITEMS.filter((it) => {
    if (!onlyFilter) return true;
    const [d, t] = onlyFilter.split(":");
    return it.domain === d && (!t || it.itemType === t);
  });
  console.log(`생성 대상 ${targets.length}개 항목 × ${TARGET}  (모델 ${MODEL})`);
  for (const item of targets) {
    const key = `${item.domain}:${item.itemType}`;
    if (bank.items[key]?.questions?.length >= TARGET && !onlyFilter) { console.log(`= ${key} 이미 ${bank.items[key].questions.length}개 — 건너뜀`); continue; }
    const qs = await genForItem(item);
    bank.items[key] = { domain: item.domain, itemType: item.itemType, source: item.source, measure: item.measure, questions: qs };
    save(bank); // 증분 저장
    console.log(`\n✓ ${key} — ${qs.length}개 저장`);
  }
  bank.model = MODEL;
  save(bank);
  const total = Object.values(bank.items).reduce((s, v) => s + v.questions.length, 0);
  console.log(`\n완료: ${OUT} — 항목 ${Object.keys(bank.items).length}개 · 총 ${total}개 질문`);
})();
