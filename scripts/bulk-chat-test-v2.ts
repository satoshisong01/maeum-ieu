/**
 * 오탐지 검증 + 요일반복 검증 테스트
 * memory_immediate 오탐지 수정 후 정상 대화가 오탐되지 않는지 확인
 * 사용법: npx tsx scripts/bulk-chat-test-v2.ts
 */
import "dotenv/config";

const BASE_URL = "http://localhost:3000";
const CONV_ID = "cmni80oop000704lk3m8ayf3b";
const COOKIE_EMAIL = "abc@abc.com";
const COOKIE_PASS = "134679";

// ─── 테스트 메시지 (정상 대화 위주 + 일부 이상 케이스) ──────────────────

const MESSAGES: { msg: string; expectedAnomaly: boolean; label: string }[] = [
  // 정상 대화 — 이전에 오탐지된 패턴 위주 (40건)
  { msg: "오늘도 산책 다녀왔어 기분 좋다", expectedAnomaly: false, label: "정상-산책" },
  { msg: "아침에 김치볶음밥 해먹었어", expectedAnomaly: false, label: "정상-식사1" },
  { msg: "점심에 칼국수 먹었는데 맛있더라", expectedAnomaly: false, label: "정상-식사2" },
  { msg: "저녁에 삼겹살 구워먹을거야", expectedAnomaly: false, label: "정상-식사3" },
  { msg: "오늘 병원 다녀왔어", expectedAnomaly: false, label: "정상-병원" },
  { msg: "약 먹는거 잊지 않고 잘 챙겨먹고 있어", expectedAnomaly: false, label: "정상-약" },
  { msg: "어제 아들이 전화왔어", expectedAnomaly: false, label: "정상-가족1" },
  { msg: "손녀가 시험 잘 봤대 기특하지", expectedAnomaly: false, label: "정상-가족2" },
  { msg: "내일 며느리네 집에 가기로 했어", expectedAnomaly: false, label: "정상-가족3" },
  { msg: "동네 할머니들이랑 수다 떨고 왔어", expectedAnomaly: false, label: "정상-사교" },
  { msg: "요즘 무릎이 안 좋아서 걱정이야", expectedAnomaly: false, label: "정상-건강1" },
  { msg: "혈압약 매일 먹고 있어", expectedAnomaly: false, label: "정상-건강2" },
  { msg: "오후에 공원에서 벚꽃 봤어 예쁘더라", expectedAnomaly: false, label: "정상-일상1" },
  { msg: "마트에서 생선 사왔어 저녁에 구울거야", expectedAnomaly: false, label: "정상-일상2" },
  { msg: "옛날에 시골에서 소 키우던 때가 그리워", expectedAnomaly: false, label: "정상-회상" },
  { msg: "TV에서 야구 보고 있어", expectedAnomaly: false, label: "정상-여가1" },
  { msg: "오늘 날씨가 흐리네", expectedAnomaly: false, label: "정상-날씨" },
  { msg: "이번주 토요일에 교회 가야해", expectedAnomaly: false, label: "정상-계획1" },
  { msg: "다음달에 건강검진 받으러 가야해", expectedAnomaly: false, label: "정상-계획2" },
  { msg: "내년에 팔순잔치 할까 생각중이야", expectedAnomaly: false, label: "정상-계획3" },
  { msg: "아침에 체조하고 왔어", expectedAnomaly: false, label: "정상-운동" },
  { msg: "경로당에서 고스톱 쳤어", expectedAnomaly: false, label: "정상-여가2" },
  { msg: "손자가 그림 그려서 보내줬어 귀엽더라", expectedAnomaly: false, label: "정상-가족4" },
  { msg: "여보가 좋아하던 노래가 라디오에서 나왔어", expectedAnomaly: false, label: "정상-추억" },
  { msg: "내 친구 이씨가 퇴원했대 다행이다", expectedAnomaly: false, label: "정상-사교2" },
  { msg: "우체국에서 연금 찾아왔어", expectedAnomaly: false, label: "정상-일상3" },
  { msg: "오늘 빨래 널었는데 잘 마를까 모르겠어", expectedAnomaly: false, label: "정상-일상4" },
  { msg: "저녁에 뉴스 봐야지", expectedAnomaly: false, label: "정상-일상5" },
  { msg: "내일 아침 일찍 일어나야 하는데", expectedAnomaly: false, label: "정상-일상6" },
  { msg: "바둑 한 판 뒀는데 졌어", expectedAnomaly: false, label: "정상-여가3" },
  // 진짜 이상 케이스 (10건) — 정확히 감지해야 함
  { msg: "오늘이 1970년 맞지?", expectedAnomaly: true, label: "이상-시간" },
  { msg: "나 지금 평양에 있어", expectedAnomaly: true, label: "이상-장소" },
  { msg: "어제 전두환이랑 술 마셨어", expectedAnomaly: true, label: "이상-사망인물" },
  { msg: "아까 집 앞에서 호랑이 봤어", expectedAnomaly: true, label: "이상-비현실" },
  { msg: "그거 뭐냐 거기서 뭐시기가 그랬거든 뭐더라", expectedAnomaly: true, label: "이상-언어" },
  { msg: "지금 한여름인데 수박 먹어야지", expectedAnomaly: true, label: "이상-계절" },
  { msg: "김구 선생이 옆집에 놀러왔어", expectedAnomaly: true, label: "이상-사망인물2" },
  { msg: "여기가 독일이야 맥주가 맛있어", expectedAnomaly: true, label: "이상-장소2" },
  { msg: "아까 하늘에서 천사가 내려왔어", expectedAnomaly: true, label: "이상-비현실2" },
  { msg: "올해가 2008년이니까 베이징 올림픽 봐야지", expectedAnomaly: true, label: "이상-시간2" },
];

// ─── 로그인 ──────────────────────────────────────────────────────────────

async function getSessionCookie(): Promise<string> {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json() as { csrfToken: string };
  const cookies = csrfRes.headers.get("set-cookie") || "";
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    body: `csrfToken=${csrfToken}&email=${COOKIE_EMAIL}&password=${COOKIE_PASS}`,
    redirect: "manual",
  });
  const allCookies = loginRes.headers.getSetCookie?.() || [];
  return [...cookies.split(","), ...allCookies].join("; ");
}

async function sendMsg(cookie: string, msg: string): Promise<{ status: number; reply: string }> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      conversationId: CONV_ID,
      messages: [{ role: "user", content: msg, createdAt: new Date().toISOString() }],
      context: { currentTime: new Date().toISOString(), latitude: 37.2049, longitude: 127.0771 },
    }),
  });
  let reply = "";
  try { reply = ((await res.json()) as { text?: string }).text || ""; } catch {}
  return { status: res.status, reply: reply.slice(0, 150) };
}

// ─── 메인 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== 오탐지 검증 테스트 v2 (40건 정상 + 10건 이상) ===\n");
  const cookie = await getSessionCookie();
  console.log("로그인 완료\n");

  let success = 0, fail = 0;
  const dayRepeatCount: number[] = []; // 요일 질문 포함 여부

  for (let i = 0; i < MESSAGES.length; i++) {
    const tc = MESSAGES[i];
    process.stdout.write(`[${i + 1}/${MESSAGES.length}] [${tc.label}] ${tc.msg.slice(0, 30)}... `);

    try {
      const result = await sendMsg(cookie, tc.msg);
      if (result.status === 200) {
        success++;
        const hasDay = /요일|무슨 요일/.test(result.reply);
        if (hasDay) dayRepeatCount.push(i + 1);
        console.log(`✅ ${result.reply.slice(0, 60)}...`);
      } else {
        fail++;
        console.log(`❌ status=${result.status}`);
      }
    } catch (e) {
      fail++;
      console.log(`❌ ${(e as Error).message.slice(0, 60)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(`\n=== 완료 ===`);
  console.log(`성공: ${success}건, 실패: ${fail}건, 총: ${MESSAGES.length}건`);
  console.log(`"요일" 질문 포함된 응답: ${dayRepeatCount.length}건 (번호: ${dayRepeatCount.join(", ")})`);
  console.log("\n⚠️ DB에서 isAnomaly 확인은 별도로 수행하세요.");
}

main().catch(console.error);
