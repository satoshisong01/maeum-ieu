// 워크플로 출력(.output)을 읽어 question-bank.json에 병합.
// 사용: node scripts/merge-question-bank-v2.mjs <verify|merge>
import fs from "node:fs";
import path from "node:path";

const TASK_DIR =
  "C:/Users/jungm/AppData/Local/Temp/claude/c--Users-jungm-Desktop-projects-maeum-ieu/cdc1346c-db26-4615-908d-c6cc916e5acb/tasks";
const CHITCHAT = path.join(TASK_DIR, "ww8oeg6kj.output");
const COGNITIVE = path.join(TASK_DIR, "w6gxmqsd5.output"); // 인지 자연화(완료 시)
const BANK = "lib/screening/question-bank.json";

function loadResult(p) {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const s = raw.indexOf("{");
    const t = raw.lastIndexOf("}");
    parsed = JSON.parse(raw.slice(s, t + 1));
  }
  // 워크플로 출력은 { summary, logs, result } 래퍼 → 실제 반환값은 result
  const r = parsed?.result ?? parsed;
  return typeof r === "string" ? JSON.parse(r) : r;
}

function summarize(label, data) {
  if (!data) {
    console.log(`[${label}] (없음/미완료)`);
    return;
  }
  console.log(
    `[${label}] items=${data.items.length} total=${data.total} low=${JSON.stringify(data.lowDiversity)}`,
  );
  for (const it of data.items)
    console.log(`   ${it.itemType}: ${it.count}개 (꼬리 ${it.tailDiversity})`);
}

const mode = process.argv[2] || "verify";
const chit = loadResult(CHITCHAT);
const cog = loadResult(COGNITIVE);

if (mode === "verify") {
  summarize("chitchat", chit);
  summarize("cognitive", cog);
  process.exit(0);
}

if (mode === "merge") {
  const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
  bank.items ??= {};
  let added = 0;
  let replaced = 0;

  // 인지 항목: v2 자연화로 교체 (있을 때만)
  if (cog?.items) {
    for (const it of cog.items) {
      if (!it.questions?.length) continue;
      const existed = bank.items[it.key];
      bank.items[it.key] = {
        domain: it.domain,
        itemType: it.itemType,
        source: it.source,
        questions: it.questions,
      };
      if (existed) replaced++;
      else added++;
    }
  }

  // 일상 수다 항목: 신규 추가
  if (chit?.items) {
    for (const it of chit.items) {
      if (!it.questions?.length) continue;
      bank.items[it.key] = {
        domain: it.domain, // 'chitchat'
        itemType: it.itemType,
        source: it.source,
        questions: it.questions,
      };
      added++;
    }
  }

  bank.generatedAt = "2026-06-08";
  bank.model = "claude-opus-4-8 (chitchat+cognitive v2)";

  const total = Object.values(bank.items).reduce(
    (s, v) => s + (v.questions?.length || 0),
    0,
  );
  fs.writeFileSync(BANK, JSON.stringify(bank, null, 2), "utf8");
  console.log(
    `병합 완료: 교체 ${replaced} · 추가 ${added} · 총항목 ${Object.keys(bank.items).length} · 총질문 ${total}`,
  );
}
