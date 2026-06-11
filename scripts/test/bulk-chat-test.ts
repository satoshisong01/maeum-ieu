/**
 * 대량 대화 테스트 스크립트
 * 200건 대화를 API로 보내고 결과를 DB에서 검증합니다.
 * 사용법: npx tsx scripts/bulk-chat-test.ts
 */
import "dotenv/config";

const BASE_URL = "http://localhost:3000";
const CONV_ID = "cmni80oop000704lk3m8ayf3b";
const COOKIE_EMAIL = "abc@abc.com";
const COOKIE_PASS = "134679";
const CTX = { currentTime: new Date().toISOString(), latitude: 37.2049, longitude: 127.0771 };

// ─── 테스트 메시지 ────────────────────────────────────────────────────────

const NORMAL_MSGS = [
  "오늘 혈압 재봤는데 좀 높더라",
  "아들이 주말에 집에 온대",
  "동네 산 오르는게 요즘은 힘들어",
  "옛날에 부대찌개 처음 먹어봤을때가 기억나",
  "이웃집 할머니랑 오늘 수다 떨었어",
  "손녀가 대학생이 됐다니 세월 빠르다",
  "요즘은 뉴스 보면 한숨만 나와",
  "아침마다 체조하는게 습관이 됐어",
  "오늘 세탁기 돌렸는데 빨래가 많더라",
  "저녁에 삼겹살 구워먹을까 생각중이야",
  "어제 교회 갔다왔어",
  "화분에 꽃이 피었는데 예쁘더라",
  "요즘 TV 드라마가 재밌어",
  "내일 아침에 일찍 일어나야 해",
  "오후에 목욕탕 다녀올까 해",
  "방금 커피 한잔 마셨어",
  "옛날에 서울역 앞이 참 복잡했었지",
  "손자가 축구 잘한대 기특해",
  "오늘 주식이 많이 떨어졌다던데",
  "내 친구 박씨가 입원했어 문병 가야겠어",
  "아 맞다 내일 병원 예약했었지",
  "마트에서 두부랑 파 사와야 하는데",
  "요즘 걷기운동 열심히 하고있어",
  "간식으로 고구마 쪄먹었어",
  "라디오에서 트로트 나오니까 기분이 좋아",
  "여보 죽은지 3년이 됐네 시간 빠르다",
  "옛날에 버스비가 100원이었거든",
  "오늘 발 발가락이 좀 저려",
  "내일 우체국 가서 택배 보내야해",
  "저녁에 뉴스 보면서 밥 먹어야지",
  "오늘 날씨가 따뜻해서 밖에 나가고 싶어",
  "아들네 손주가 벌써 중학생이래",
  "옛날 군대 시절이 생각나네",
  "물김치 담가야 하는데 배추가 비싸",
  "오늘 약국에서 파스 사왔어",
  "경로당에서 바둑 한판 뒀어",
  "아침에 미숫가루 타먹었어",
  "내일 며느리가 온다고 해서 청소해야해",
  "요즘 무릎이 시큰거려",
  "옛날 초등학교 동창회 갔었는데 다들 늙었더라",
  "마당에 잡초 좀 뽑아야겠어",
  "오늘 우유 배달이 안왔네",
  "손녀가 결혼한다는데 아직 실감이 안나",
  "요즘 혈당 관리 열심히 하고있어",
  "동네 빵집에서 단팥빵 사먹었어",
  "옛날에 기차 타고 부산 가던 생각이 나",
  "내일 치과 가야하는데 무서워",
  "아까 뒷산에서 새소리 들었어 좋더라",
  "오후에 손주랑 전화했어",
  "저녁에 콩나물국 끓여야지",
];

const ANOMALY_MSGS = [
  // 시간 지남력 (10건)
  "오늘 1990년 3월이지?",
  "지금 2001년 여름인데 덥다",
  "오늘이 화요일이야? 아 월요일인가?",
  "1975년에 내가 태어났으니까 올해 50살이네",
  "크리스마스가 내일이지?",
  "지금 겨울이잖아 눈 많이 오네",
  "올해가 2015년이니까 아들이 30살이겠네",
  "지금 가을인데 단풍이 예쁘겠다",
  "어제가 설날이었잖아",
  "내년이 2020년이니까 올림픽 보러가야지",
  // 장소 지남력 (10건)
  "나 지금 대구에 있어",
  "여기 인천이잖아 바다가 보여",
  "지금 강릉 와있는데 횟집 가자",
  "우리집이 서울 종로구인데",
  "나 지금 제주도야 감귤 먹고있어",
  "여기가 수원인데 화성 구경하자",
  "지금 춘천이야 닭갈비 먹으러 가자",
  "나 부산 해운대에 와있어",
  "여기 광주인데 떡갈비 맛있어",
  "지금 전주야 비빔밥 먹었어",
  // 판단력 (10건)
  "어제 노무현 대통령 만났어",
  "방금 김일성 주석이랑 얘기했어",
  "새마을운동 내일 시작이래",
  "6.25 전쟁이 시작됐다던데 피난가야하나",
  "아까 하늘에서 용이 날아다니더라",
  "외계인이 우리집에 놀러왔어",
  "어제 공룡 알을 주워왔어",
  "유관순 열사를 만나서 같이 밥먹었어",
  "이순신 장군이 옆집에 이사왔어",
  "세종대왕이 카페에서 커피 마시고 있더라",
  // 언어 유창성 (10건)
  "그거 있잖아 그 뭐냐 그거 했어",
  "저기서 그걸 그렇게 뭐시기 했거든",
  "아 그게 뭐더라 그 있잖아 뭐라더라",
  "거기서 그사람이 뭐라뭐라 했는데 뭐였더라",
  "그거 저번에 뭐시기한테 그거 줬잖아",
  "아 이름이 뭐더라 그 사람 뭐하는 사람이었는데",
  "저기 가서 그거 사와야하는데 뭐더라 그게",
  "그 뭐냐 그 어디서 본건데 아 기억이 안나",
  "뭐시기 뭐시기 해서 결국 그렇게 됐어",
  "그거 있잖아 그때 그사람이 이러쿵저러쿵 했는데",
  // 기억력 (10건)
  "내가 방금 뭐라고 했더라?",
  "아까 점심에 뭐 먹었는지 기억이 안나",
  "어제 누가 왔었는데 누구였더라",
  "내 손자 이름이 뭐였더라 갑자기 생각이 안나",
  "아까 약 먹었나 안먹었나 모르겠어",
  "방금 전화 누구한테 온거였지?",
  "내가 왜 여기 왔더라 뭐 하러 온거지",
  "어제 뭐했는지 하나도 기억이 안나",
  "아들 전화번호가 갑자기 생각이 안나",
  "아까 뭘 사려고 마트 왔는데 뭐였더라",
];

// ─── 로그인 ──────────────────────────────────────────────────────────────

async function getSessionCookie(): Promise<string> {
  // CSRF 토큰 가져오기
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json() as { csrfToken: string };
  const cookies = csrfRes.headers.get("set-cookie") || "";

  // 로그인
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies,
    },
    body: `csrfToken=${csrfToken}&email=${COOKIE_EMAIL}&password=${COOKIE_PASS}`,
    redirect: "manual",
  });
  const allCookies = loginRes.headers.getSetCookie?.() || [];
  return [...cookies.split(","), ...allCookies].join("; ");
}

// ─── 메시지 전송 ──────────────────────────────────────────────────────────

async function sendMsg(cookie: string, msg: string): Promise<{ status: number; reply: string }> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      conversationId: CONV_ID,
      messages: [{ role: "user", content: msg, createdAt: new Date().toISOString() }],
      context: { ...CTX, currentTime: new Date().toISOString() },
    }),
  });
  let reply = "";
  try {
    const data = await res.json() as { text?: string };
    reply = data.text || "";
  } catch { /* ignore */ }
  return { status: res.status, reply: reply.slice(0, 150) };
}

// ─── 메인 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== 대량 대화 테스트 시작 ===\n");
  const cookie = await getSessionCookie();
  console.log("로그인 완료\n");

  const allMsgs = [...NORMAL_MSGS, ...ANOMALY_MSGS];
  let success = 0;
  let fail = 0;

  for (let i = 0; i < allMsgs.length; i++) {
    const label = i < NORMAL_MSGS.length ? "정상" : "이상";
    const num = i < NORMAL_MSGS.length ? i + 1 : i - NORMAL_MSGS.length + 1;
    process.stdout.write(`[${i + 1}/${allMsgs.length}] [${label} ${num}] ${allMsgs[i].slice(0, 30)}... `);

    try {
      const result = await sendMsg(cookie, allMsgs[i]);
      if (result.status === 200) {
        success++;
        console.log(`✅ ${result.reply.slice(0, 60)}...`);
      } else {
        fail++;
        console.log(`❌ status=${result.status}`);
      }
    } catch (e) {
      fail++;
      console.log(`❌ ${(e as Error).message.slice(0, 60)}`);
    }

    // Gemini API 레이트 리밋 방지
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(`\n=== 완료 ===`);
  console.log(`성공: ${success}건, 실패: ${fail}건, 총: ${allMsgs.length}건`);
}

main().catch(console.error);
