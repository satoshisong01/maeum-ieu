/**
 * SOFT_SIGNAL 정밀화 안전성 실검증 — "이제 백스톱을 안 부르게 된" 실로그 발화 전수에
 * 실제 백스톱 LLM을 돌려, 진짜 응급(L2+)이 하나라도 누락됐는지 확인.
 *   dropped = 정규식 none AND 옛 트리거는 잡았으나 현 트리거는 skip
 *   dropped 중 백스톱이 L2+로 판정하는 게 있으면 → 내가 과도하게 좁혀 누락을 만든 것(복구 필요).
 * 실행: npx tsx scripts/validate-dropped-backstop.ts
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { detectEmergency } from "../lib/chat/emergency";
import { detectEmergencyLLM, SOFT_SIGNAL } from "../lib/chat/emergency-llm";

// 변경 전(a0f7f87) 트리거
const OLD_SOFT = /약|수면제|죽|자살|목(?:이라도|을|에)?\s*[매졸]|매달|올가미|끈\s|뛰어내|투신|번개탄|연탄|손목|그어|칼\s*[들로써맞]|면도날|동맥|자해|목숨|세상\s*[뜨떠]|저\s*세상|먼저\s*[가갈]|따라\s*[가갈]|곁으로|조용히\s*[가갈떠]|떠날|떠나려|떠나야|하직|없어야|없으면\s*(?:편|낫|좋)|나\s*없으면|가\s*[뿌뿔삐불]|살\s*맛|폐[\s가-힣]{0,4}끼|짐\s*(?:만|이|덩)|그만\s*살|살기\s*(?:가|를)?\s*싫|사라[지져]|짐[\s가-힣]{0,6}정리|빠져\s*주|살아야\s*할\s*(?:까닭|이유)|살아갈\s*(?:이유|까닭)|살\s*(?:까닭|이유)\s*(?:가|이)?\s*없|살아서\s*[뭐뭣]|마지막일|잘\s*있으[란라]|이만\s*[가갈]|이만\s*정리|나눠\s*[줬줄주]|갈\s*때가\s*[됐되왔]|잘\s*지내[라요]|그동안\s*고마|더는\s*안\s*[봐볼]|없어졌으면|없어져|없어지고|눈\s*감|눈\s*안\s*[뜨떠떴]|안\s*깨|깨어나|영원|편하게\s*[가갈]|편히\s*[가갈]|(?:죽는|가는|편한)\s*방법|고통\s*없이|갈\s*수\s*있는\s*방법|끝내|끝장|못\s*견디|고통스러|모[아았]|털어|들이[켜키]|삼[키켜켰]|먹어버|먹어불|입에\s*[넣털]|두\s*번|두\s*알|세\s*알|한\s*알|또\s*먹|또\s*한\s*번|한\s*번\s*더|안\s*먹은\s*줄|섞어|헷갈|착각|움큼|한\s*통|숨|가슴|쓰러|넘어|미끄러|자빠|나자빠|삐끗|엎어|고꾸라|못\s*일어|일어나지\s*(?:를\s*)?못|일어날\s*수가?\s*없|주저앉|폭삭|허리를?\s*못\s*[쓰써]|피[가\s]|출혈|어지|핑\s*도|식은\s*땀|손\s*(?:이|을)?\s*떨|떨려|떨린|마비|경련|발작|거품|뻣뻣|떨면서|경기들|의식|정신이\s*[흐혼아가]|캄캄|아득|가물가물|혼미|안\s*올라가|헛나|어눌|혀\s*꼬|부들부들|벌벌\s*떨|덜덜\s*떨|거품\s*물|까무러|까무라|기절|혼절|삐[뚤뚜]|비뚤|감각\s*(?:이|도)?\s*(?:없|둔)|(?:한|왼|오른|반)\s*[쪽짝편]\s*(?:팔|다리|손|발|몸|얼굴|눈|입)|반신\s*마|기운\s*(?:이|을)?\s*(?:없|빠)|기력|당뇨|혈압|토[하해]|구역|메스|데[였여어]|화상|끓는|뜨거운\s*물|물집|살갗|부러|골절|삐[었어]|쥐\s*나|저[려린릿]|열이\s*(?:나|많|펄)|힘들|외로|혼자|괴로|우울|허전|보고\s*싶|그립|눈물/;

async function main() {
  const rows = await prisma.message.findMany({ where: { role: "user" }, select: { content: true } });
  // 중복 제거 + dropped 추출
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const r of rows) {
    const t = (r.content || "").trim();
    if (!t || seen.has(t)) continue; seen.add(t);
    if (detectEmergency(t).level > 0) continue;          // 정규식이 직접 잡음 → 무관
    if (OLD_SOFT.test(t) && !SOFT_SIGNAL.test(t)) dropped.push(t);  // 옛날엔 백스톱, 이제 skip
  }
  console.log(`검증 대상(dropped, 중복제거): ${dropped.length}건 — 실제 백스톱 LLM 전수 실행\n`);

  const misses: { text: string; cat: string; lvl: number }[] = [];
  let done = 0, errNull = 0;
  for (const t of dropped) {
    const r = await detectEmergencyLLM(t);  // 정규식 none이므로 백스톱이 곧 최종판정
    done++;
    if (r && r.level >= 2) { misses.push({ text: t, cat: r.category, lvl: r.level }); console.log(`  ⚠ 누락의심 L${r.level}/${r.category} | ${t.slice(0, 50)}`); }
    if (done % 50 === 0) console.log(`  ...${done}/${dropped.length} (누락의심 ${misses.length})`);
  }

  console.log(`\n===== 결과 =====`);
  console.log(`검증 ${done}건 · 누락의심(L2+) ${misses.length}건`);
  if (misses.length === 0) {
    console.log(`✅ 정밀화 안전 — 백스톱에서 빠진 발화 중 실제 응급으로 판정되는 것 0건(오탐만 제거됨).`);
  } else {
    console.log(`❌ ${misses.length}건이 응급으로 판정됨 — 해당 토큰 복구 필요:`);
    for (const m of misses) console.log(`   L${m.lvl}/${m.cat} | ${m.text}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
