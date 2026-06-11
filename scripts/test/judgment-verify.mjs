/**
 * AI 판단 정확도 검증 — 레벨별(정상/경증/중증/고위험) 질문·대답·판단 리포트 생성.
 *
 * 정상/경증/중증: 발화 단위 케이스를 판단 엔진(analyzeCognitive)에 직접 넣어
 *   기대 점수(0/1/2)로 채점되는지 검증 → docs/판단검증_정상.md / _경증.md / _중증.md
 * 고위험: 종합등급(overallAvg≥1.5)이라 누적 프로파일(여러 답변)로 검증 → docs/판단검증_고위험.md
 *
 * 사용: node scripts/judgment-verify.mjs
 * 사전: GEMINI_API_KEY (.env). 분석기는 503 transient 재시도 내장.
 */
import "dotenv/config";
import fs from "fs";
import { analyzeCognitive } from "../../lib/chat/cognitive-analyzer";
import { classifySeverity, computeOverallAvg } from "../../lib/health/severity";

// 산출 경로 — 패치/버전별 reports 폴더 (env로 오버라이드 가능)
const OUT_DIR = process.env.REPORT_DIR || "docs/reports/2026-06-02_gemini-3.5-flash";
fs.mkdirSync(OUT_DIR, { recursive: true });

const ENV = `[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]
- 현재 한국 시각: 2026년 6월 2일 화요일 오후 2시 10분
- 시간대: 오후
- 사용자 현재 위치: 경기도 화성시 동탄
- 사용자 나이: 78세 (여성)
날짜/요일/시각/위치를 말할 때는 반드시 위 정보를 사용하세요.`;

const H = (q) => `AI: ${q}`; // AI 질문(맥락) 헬퍼

// ─────────────────────────────────────────────────────────────────────────
// 정상(score 0) — 20 케이스
const NORMAL = [
  { d: "orientation_time", q: "오늘 무슨 요일이에요?", a: "오늘 화요일이지" },
  { d: "orientation_time", q: "지금 몇 월쯤 됐죠?", a: "유월 초입이지, 곧 여름이고" },
  { d: "orientation_time", q: "올해가 몇 년도예요?", a: "이천이십육년이지" },
  { d: "orientation_time", q: "요즘 계절이 어떤 것 같아요?", a: "초여름이지, 아침저녁으론 아직 선선해" },
  { d: "orientation_place", q: "지금 어디 계세요?", a: "우리 집 안방이지, 동탄 우리 아파트" },
  { d: "orientation_place", q: "여기가 어느 동네예요?", a: "화성 동탄이지, 여기서 십 년 넘게 살았어" },
  { d: "memory_delayed", q: "아까 외운 단어 세 개 기억나세요?", a: "나무, 자동차, 모자 세 개 다 기억나지" },
  { d: "memory_delayed", q: "큰아들 이름이 뭐였죠?", a: "큰애는 영수고 둘째는 영호야" },
  { d: "language", q: "동물 이름 최대한 말해보세요", a: "개 소 돼지 닭 토끼 고양이 호랑이 사자 곰 코끼리" },
  { d: "language", q: "'백문이 불여일견' 무슨 뜻이에요?", a: "백 번 듣는 것보다 한 번 직접 보는 게 낫다는 말이지" },
  { d: "judgment", q: "길에서 지갑을 주우면 어떻게 하실 거예요?", a: "파출소에 갖다줘야지, 주인이 찾아야 할 거 아니냐" },
  { d: "judgment", q: "집에 불이 나면 어떻게 하시겠어요?", a: "가스부터 잠그고 119 부르고 얼른 밖으로 나가야지" },
  { d: "judgment", q: "모르는 사람이 돈 부치라고 전화하면?", a: "그건 보이스피싱이지, 바로 끊어버려야 해" },
  { d: "attention_calculation", q: "100에서 7을 빼면 얼마예요?", a: "구십삼이지" },
  { d: "attention_calculation", q: "만 원 내고 삼천 원짜리 두부 사면 거스름돈은?", a: "칠천 원 받아야 맞지" },
  { d: "attention_calculation", q: "100에서 7씩 계속 빼보세요", a: "구십삼, 팔십육, 칠십구, 칠십이, 육십오" },
  { d: "daily", q: "점심은 뭐 드셨어요?", a: "된장찌개에 밥 한 그릇 뚝딱 했지" },
  { d: "daily", q: "오늘 기분은 어떠세요?", a: "날이 좋아서 그런지 기분도 아주 좋아" },
  { d: "daily", q: "주말엔 보통 뭐 하세요?", a: "교회 다녀오고 손주들 얼굴 보는 게 낙이지" },
  { d: "daily", q: "건강은 어떻게 챙기세요?", a: "혈압약 거르지 않고 챙겨 먹고 매일 동네 한 바퀴 걸어" },
  // ── 확장(2026-06-02, 적대적 검증 통과) ──
  { d: "orientation_time", q: "할머니 생신이 언제세요?", a: "내 생일은 음력으로 칠월 열엿새야. 양력으로는 해마다 날짜가 왔다 갔다 하지." },
  { d: "orientation_place", q: "여기가 어느 동네예요?", a: "여기 동탄이지. 호수공원 가까운 데. 산책하기 딱 좋아." },
  { d: "orientation_place", q: "오늘 어디 다녀오셨어요?", a: "동탄 시장 들렀다가 농협 들러서 통장 정리하고 왔어." },
  { d: "memory_delayed", q: "아까 외워드린 단어 세 개 기억나세요?", a: "기억나지. 연필, 강아지, 우산. 세 개 맞지?" },
  { d: "memory_delayed", q: "올해 연세가 어떻게 되세요?", a: "나 세는 나이로 여든이야. 만으로는 일흔여덟이고. 한국 사람은 다 그렇게 한 살 더 치잖아." },
  { d: "language", q: "'가지 많은 나무에 바람 잘 날 없다'가 무슨 뜻일까요?", a: "자식 많으면 그만큼 걱정거리도 끊일 날 없다 그 말이지. 다 키워봐서 알아." },
  { d: "language", q: "어제 점심은 뭐 드셨는지 여쭤봐도 될까요?", a: "응? 뭐라고? 잘 안 들려, 좀 크게 말해줘." },
  { d: "judgment", q: "한밤중에 가스 냄새가 나면 어떻게 하실 거예요?", a: "창문부터 활짝 열고 가스 밸브 잠근 다음에 가스공사에 전화해야지. 불은 절대 안 켜고." },
  { d: "judgment", q: "기차표를 잘못 사서 시간이 안 맞으면 어떻게 하시겠어요?", a: "역무원한테 가서 표 바꿔달라고 해야지. 다음 차로 변경되나 물어보면 돼." },
  { d: "attention_calculation", q: "50에서 8을 빼면 얼마예요?", a: "오십에서 여덟 빼면 마흔둘이지. 사십이." },
  { d: "attention_calculation", q: "오천 원짜리 두부 사고 만 원 내면 거스름돈이 얼마죠?", a: "오천 원 받겠네. 만 원에서 오천 원 빼면 오천 원이니까." },
  { d: "attention_calculation", q: "손주 셋한테 사탕 두 개씩 나눠주려면 몇 개 필요해요?", a: "셋한테 두 개씩이면 여섯 개 있어야지." },
];

// 경증(score 1) — 설계된 경계 도메인(시간/장소/지연기억/언어/계산)
const MILD = [
  { d: "orientation_time", q: "올해가 몇 년도예요?", a: "한 이천십년쯤 됐나… 옛날 생각이 자꾸 나서 헷갈리네" },
  { d: "orientation_time", q: "지금 무슨 계절 같으세요?", a: "겨울인가… 예전 시골 살 때가 생각나서 그런지 가물가물해" },
  { d: "orientation_time", q: "이번 달이 몇 월이죠?", a: "삼월인가 사월인가… 요새 날짜를 자꾸 까먹어서 헷갈려" },
  { d: "orientation_place", q: "지금 어디 계세요?", a: "여기가 부산인가… 옛날 살던 데가 자꾸 떠올라서 헷갈리네" },
  { d: "orientation_place", q: "여기가 어디예요?", a: "어릴 때 자란 시골집 같기도 하고… 잠깐 헷갈렸네" },
  { d: "memory_delayed", q: "아까 외운 단어 세 개 기억나세요?", a: "나무하고 자동차는 나는데 마지막 하나가 영 안 나네" },
  { d: "memory_delayed", q: "외운 단어 세 개 말해보세요", a: "두 개는 알겠는데 나머지 하나가 통 생각이 안 나" },
  { d: "language", q: "동물 이름 최대한 대보세요", a: "개 고양이 소 돼지 닭 토끼" },
  { d: "language", q: "1분 동안 동물 이름 말해보세요", a: "개 소 말 닭 오리 토끼 사슴" },
  { d: "language", q: "'가는 말이 고와야 오는 말이 곱다'가 무슨 뜻이에요?", a: "음… 말을 곱게 타고 다니란 건가? 잘 모르겠네" },
  { d: "attention_calculation", q: "100에서 7씩 빼보세요", a: "구십삼… 팔십육… 칠십팔? 아니 칠십구인가 헷갈리네" },
  { d: "attention_calculation", q: "100에서 7을 빼면?", a: "구십삼… 아니 구십사인가? 잠깐 헷갈리네" },
  { d: "memory_delayed", q: "5단어(얼굴 비단 교회 카네이션 빨강) 기억나세요?", a: "얼굴하고 교회, 빨강… 세 개는 나는데 나머지가 안 나" },
  { d: "language", q: "동물 이름 더 말해보세요", a: "소 개 돼지 염소 닭" },
  // ── 확장(2026-06-02, 적대적 검증 통과) ──
  { d: "orientation_time", q: "할머니, 올해가 몇 년도인지 아세요?", a: "올해가… 이천십오 년인가? 아유 옛날 생각이 자꾸 나서 자꾸 헷갈리네, 가물가물해." },
  { d: "orientation_time", q: "지금이 무슨 계절이에요?", a: "가을인가… 단풍 들 때 생각이 나서 헷갈리네. 요새는 영 가물가물해서." },
  { d: "orientation_time", q: "오늘이 몇 월쯤 되나요?", a: "구월인가 시월인가… 추석 무렵 같은데 나도 영 모르겠네, 자꾸 까먹어." },
  { d: "orientation_time", q: "지금 몇 년도쯤 됐을까요?", a: "한 이천 년 됐나… 젊었을 때 생각이 나서 그런가 영 헷갈리네." },
  { d: "orientation_place", q: "할머니 지금 어디 계세요?", a: "여기가 인천인가… 옛날 친정 살던 데가 자꾸 생각나서 헷갈리네." },
  { d: "orientation_place", q: "지금 계신 동네가 어디예요?", a: "수원 아닌가… 시집오기 전에 살던 데 같아서 영 헷갈리네, 가물가물해." },
  { d: "orientation_place", q: "여기가 어느 도시인지 아세요?", a: "대전인가 싶기도 하고… 예전에 쭉 살던 데가 떠올라서 잘 모르겠네." },
  { d: "memory_delayed", q: "아까 제가 외워달라고 한 단어 세 개 기억나세요?", a: "음… 연필하고 시계는 나는데, 마지막 한 개가 영 안 떠올라. 입에서 맴돌기만 하네." },
  { d: "memory_delayed", q: "조금 전에 드린 단어 세 개 다시 말해보실래요?", a: "바지하고 사과… 그 다음 한 개는 도무지 생각이 안 나네. 두 개밖에 못 대겠어." },
  { d: "language", q: "일 분 안에 아는 동물 이름 최대한 많이 대보세요.", a: "개… 고양이… 소… 돼지… 닭… 토끼… 그담은 영 생각이 안 나네, 여섯 개쯤 했나." },
  { d: "language", q: "'우물 안 개구리'가 무슨 뜻인지 아세요?", a: "우물 속에 개구리가 들어앉아 있다는 거 아닌가… 깊은 뜻은 잘 모르겠네, 어렴풋해." },
  { d: "language", q: "'발 없는 말이 천 리 간다'는 무슨 뜻일까요?", a: "말이 발도 없이 천 리를 간다는… 글쎄 정확한 속뜻은 가물가물하네." },
  // ── 확장(2026-06-04, 레벨별 30+ 보강) ──
  { d: "orientation_time", q: "오늘이 무슨 요일이에요?", a: "글쎄 화요일인가… 아니 수요일인가, 요새 요일이 자꾸 헷갈려서 영 모르겠네." },
  { d: "orientation_time", q: "이번 달이 몇 월이죠?", a: "오월인가 유월인가… 자꾸 한 달씩 헷갈리네, 날짜 개념이 가물가물해." },
  { d: "orientation_place", q: "지금 어느 동네에 계세요?", a: "여기가 안양인가… 옛날 살던 데가 자꾸 떠올라서 헷갈려, 잘 모르겠네." },
  { d: "memory_delayed", q: "아까 외운 단어 세 개 말해보세요.", a: "우산하고 기차는 나는데 마지막 하나가 영 안 떠오르네, 두 개밖에 못 대겠어." },
  { d: "memory_delayed", q: "조금 전에 드린 세 단어 기억나세요?", a: "모자하고 연필… 그 다음 한 개가 통 생각이 안 나, 둘만 나네." },
  { d: "language", q: "과일 이름 최대한 많이 대보세요.", a: "사과… 배… 감… 귤… 음 그담은 영 생각이 잘 안 나네, 네댓 개 했나." },
  { d: "language", q: "'백지장도 맞들면 낫다'가 무슨 뜻이에요?", a: "종이를 같이 든다는 건가… 정확한 속뜻은 가물가물해서 잘 모르겠네." },
  { d: "attention_calculation", q: "100에서 7씩 빼보세요.", a: "구십삼… 팔십육… 칠십구… 그담이 칠십삼인가 칠십이인가, 영 헷갈리네." },
];

// 중증(score 2) — 명백한 이상
const SEVERE = [
  { d: "orientation_time", q: "올해가 몇 년도예요?", a: "올해가 1988년이지, 곧 서울올림픽 한다고 떠들썩하잖아" },
  { d: "orientation_time", q: "오늘이 며칠이에요?", a: "오늘 2003년 3월이지? 곧 봄이라 좋구만" },
  { d: "orientation_time", q: "지금 무슨 계절이에요?", a: "한겨울이라 눈이 펑펑 오잖아" },
  { d: "orientation_place", q: "지금 어디 계세요?", a: "나 지금 뉴욕 한복판에 나와 있어, 사람이 엄청 많네" },
  { d: "orientation_place", q: "여기가 어디예요?", a: "여기 부산 해운대 바닷가잖아, 갈매기 많고" },
  { d: "judgment", q: "오늘 무슨 계획 있으세요?", a: "어제 박정희 대통령이 우리집에 차 마시러 왔다 갔어" },
  { d: "judgment", q: "내일 뭐 하실 거예요?", a: "내일 이순신 장군 만나서 같이 점심 먹기로 했어" },
  { d: "judgment", q: "오늘 특별한 일 있었어요?", a: "아까 마당에 외계인이 내려와서 한참 얘기하다 갔어" },
  { d: "judgment", q: "지금 뭐 하려고 하세요?", a: "새벽 세 시인데 시장 보러 나가려고, 장 봐야지" },
  { d: "memory_delayed", q: "아까 외운 단어 세 개 기억나세요?", a: "단어? 통 하나도 생각이 안 나, 머릿속이 깜깜해" },
  { d: "memory_delayed", q: "큰아들 이름이 뭐예요?", a: "큰아들 이름이… 모르겠어, 도무지 기억이 안 나" },
  { d: "language", q: "동물 이름 말해보세요", a: "동물… 개… 그리고… 음 그게 뭐더라 생각이 안 나" },
  { d: "language", q: "이거 뭔지 설명해보세요", a: "그… 그거 있잖아 저기… 뭐라고 하더라 그거 말이야" },
  { d: "attention_calculation", q: "100에서 7을 빼면?", a: "글쎄… 한 팔십오쯤 되나?" },
  { d: "attention_calculation", q: "두부 만 원어치 샀는데 거스름돈 얼마 받으셨어요?", a: "만원짜리 두부 샀는데 거스름돈을 이만 원이나 받아왔지 뭐야" },
  { d: "attention_calculation", q: "콩나물 사고 얼마 거슬러 받으셨어요?", a: "콩나물 삼천원어치 사고 천원 냈는데 사천원 거슬러 받았어" },
  { d: "judgment", q: "요즘 어떻게 지내세요?", a: "지난주에 돌아가신 영감이 마당에서 나 부르길래 같이 밥 먹었어" },
  { d: "orientation_time", q: "지금이 몇 년도예요?", a: "올해 1972년이지, 새마을운동 한다고 다들 바빠" },
  { d: "orientation_place", q: "지금 계신 곳이 어디예요?", a: "지금 서울 남대문시장 한복판이야, 바글바글해" },
  { d: "judgment", q: "오늘 뭐 하셨어요?", a: "어제 김구 선생이랑 차 한잔 하면서 나라 얘기 했지" },
  // ── 확장(2026-06-02, 적대적 검증 통과) ──
  { d: "orientation_time", q: "할머니, 올해가 몇 년도인지 아세요?", a: "올해가 천구백칠십육년이지 뭐. 박정희 대통령 시절이잖아, 그건 내가 똑똑히 알아." },
  { d: "orientation_time", q: "지금이 무슨 계절인 것 같으세요?", a: "지금이야 한창 가을이지. 밖에 단풍 들고 추석 지난 지 얼마 안 됐잖아." },
  { d: "orientation_time", q: "오늘이 몇 월쯤 됐을까요?", a: "섣달이지 섣달. 곧 설이라 떡국 끓일 준비 해야 돼." },
  { d: "orientation_place", q: "할머니, 지금 계신 곳이 어디예요?", a: "여기 인천 우리 친정집이지. 부엌에서 어머니가 밥하는 소리 들리잖아." },
  { d: "orientation_place", q: "지금 어느 동네에 사세요?", a: "제주도 서귀포지. 창밖에 귤밭 보이고 바다도 가까워." },
  { d: "memory_delayed", q: "아까 제가 외워보라고 한 단어 세 개 기억나세요?", a: "아유 그게 뭐였더라… 하나도 생각이 안 나네. 외운 것도 가물가물해." },
  { d: "memory_delayed", q: "조금 전에 알려드린 단어 세 개 다시 말씀해 보실래요?", a: "음… 사과? 그거 하나밖에 모르겠어. 나머지는 영 떠오르질 않아." },
  { d: "memory_delayed", q: "할머니 큰딸 이름이 어떻게 되세요?", a: "우리 큰딸… 아이고 이름이 뭐더라. 낳아 키운 자식인데도 통 생각이 안 나네." },
  { d: "memory_delayed", q: "결혼은 어디 분이랑 하셨어요? 고향이 어디세요?", a: "내가 어디서 태어났는지를 모르겠어. 고향이 어디였더라, 도무지 떠오르질 않아." },
  { d: "language", q: "할머니, 아침에 머리 빗을 때 쓰는 거 이름이 뭐죠?", a: "아 그… 그거 있잖아 그거. 머리에 대고 쓱쓱 하는 그거… 이름이 뭐더라 영 생각이 안 나." },
  { d: "language", q: "오늘 점심은 뭐 드셨어요?", a: "그… 저기 그릇에 담아서 그거 했는데… 그 뭐냐 저거랑 같이… 아 말이 안 나오네 그게 뭐더라." },
  { d: "language", q: "동물 이름 아무거나 몇 가지 말씀해 보실래요?", a: "동물… 개… 개. 또 그… 음… 그 뭐냐 그거… 생각이 안 나. 개밖에 모르겠어." },
  { d: "judgment", q: "요즘 누구 보고 싶은 사람 있으세요?", a: "엊그제 육영수 여사가 우리 집에 차 마시러 왔다 갔어. 손도 곱고 참 인자하시더라." },
  { d: "judgment", q: "이번 주말에 뭐 하실 계획 있으세요?", a: "세종대왕님 만나뵈러 경복궁 가기로 했어. 한글 만드신 분이라 꼭 한번 뵙고 싶었거든." },
  { d: "judgment", q: "어제는 어떻게 보내셨어요?", a: "어제 마당에 용이 한 마리 내려와서 한참 같이 놀았지. 비늘이 반짝반짝하니 예쁘더라." },
  { d: "judgment", q: "요즘 특별히 새로 시작한 일 있으세요?", a: "다음 달에 나 시집가. 신랑감이 참 듬직해서 어머니가 좋아하셔." },
  { d: "judgment", q: "어젯밤엔 뭐 하셨어요?", a: "어젯밤에 옆집에 우주선이 내려서 외계 사람들이랑 저녁을 같이 먹었어. 음식도 나눠 줬지." },
  { d: "attention_calculation", q: "할머니, 100에서 7을 빼면 얼마예요?", a: "백에서 칠 빼면… 팔십이지. 응, 팔십이 맞아." },
  { d: "attention_calculation", q: "사과 한 봉지에 오천 원인데 만 원 내면 얼마 거슬러 받으세요?", a: "오천 원짜리 사고 만 원 줬으니 거스름돈 삼만 원 받아야지." },
  { d: "attention_calculation", q: "칠천 원짜리 생선 사고 만 원 내시면 얼마 받으셔야 돼요?", a: "칠천 원짜리에 만 원 냈으면 칠천 원 도로 받아야 맞지." },
  { d: "attention_calculation", q: "손주 둘한테 만 원씩 주려면 모두 얼마가 필요할까요?", a: "둘한테 만 원씩 주면… 오천 원이면 되겠네. 응 오천 원." },
];

// 고위험(종합등급) — 누적 프로파일. 각 프로파일의 답변들을 분석 → overallAvg → 등급.
// 고위험은 발화단위 점수가 아니라 누적평균≥1.5인 종합등급이므로 다양한 누적 시나리오로 검증.
const PROFILES = [
  // ── 등급 스펙트럼 (정상→고위험 단조 상승 확인) ──
  {
    name: "스펙트럼·정상군", targetTier: "정상",
    answers: [
      { q: "오늘 무슨 요일이에요?", a: "오늘 화요일이지" },
      { q: "지금 어디 계세요?", a: "동탄 우리 집이지" },
      { q: "100에서 7 빼면?", a: "구십삼이지" },
      { q: "지갑 주우면?", a: "파출소에 갖다줘야지" },
      { q: "동물 이름 대보세요", a: "개 소 돼지 닭 토끼 고양이 호랑이 사자" },
      { q: "점심 드셨어요?", a: "된장찌개 맛있게 먹었지" },
    ],
  },
  {
    name: "스펙트럼·경증군", targetTier: "경증",
    answers: [
      { q: "오늘 며칠이에요?", a: "오늘 화요일 맞지" },
      { q: "단어 세 개 기억나세요?", a: "두 개는 나는데 하나가 통 안 나네" },
      { q: "동물 이름 대보세요", a: "개 고양이 소 돼지 닭 토끼" },
      { q: "올해 몇 년도예요?", a: "이천십년쯤인가… 옛날 생각나서 헷갈리네" },
      { q: "100에서 7 빼면?", a: "구십삼이지" },
      { q: "지금 어디세요?", a: "우리 집이지 동탄" },
    ],
  },
  {
    name: "스펙트럼·중증군", targetTier: "중증",
    answers: [
      { q: "지금 어디세요?", a: "여기 부산 해운대 바닷가지" },
      { q: "단어 세 개 기억나세요?", a: "하나도 생각이 안 나" },
      { q: "두부 사고 거스름 얼마 받았어요?", a: "만원짜리 두부 샀는데 거스름 이만원 받았어" },
      { q: "오늘 무슨 요일이에요?", a: "오늘 화요일이지" },
      { q: "길에서 지갑 주우면?", a: "파출소에 갖다줘야지" },
    ],
  },
  {
    name: "스펙트럼·고위험군", targetTier: "고위험",
    answers: [
      { q: "올해 몇 년도예요?", a: "올해 1972년이지 새마을운동 하잖아" },
      { q: "지금 어디세요?", a: "나 지금 뉴욕 한복판이야" },
      { q: "오늘 계획 있어요?", a: "어제 박정희 대통령이 집에 왔다 갔어" },
      { q: "단어 세 개 기억나세요?", a: "하나도 생각 안 나 깜깜해" },
      { q: "100에서 7 빼면?", a: "글쎄 팔십쯤 되나" },
      { q: "두부 사고 거스름 얼마 받았어요?", a: "만원짜리 두부 샀는데 이만원 거슬러 받았어" },
    ],
  },
  // ── 고위험 집중 케이스 (다양한 누적 시나리오가 모두 고위험으로 잡히는가) ──
  {
    name: "고위험·사망인물 다발", targetTier: "고위험",
    answers: [
      { q: "오늘 누구 만나셨어요?", a: "어제 박정희 대통령이 우리집에 차 마시러 왔어" },
      { q: "주말 계획 있으세요?", a: "내일 이순신 장군이랑 같이 점심 먹기로 했어" },
      { q: "요즘 어떻게 지내세요?", a: "지난주에 돌아가신 영감이 마당에서 나 부르길래 같이 밥 먹었지" },
      { q: "누구랑 얘기하셨어요?", a: "아까 김구 선생이랑 나라 걱정하면서 차 한잔 했어" },
      { q: "오늘 기분 어때요?", a: "좋아, 옛 친구들 다 만나서" },
    ],
  },
  {
    name: "고위험·시대착오 다발", targetTier: "고위험",
    answers: [
      { q: "올해 몇 년도예요?", a: "올해 1988년이지 곧 서울올림픽 하잖아" },
      { q: "요즘 무슨 일 있어요?", a: "새마을운동 한다고 온 동네가 바빠" },
      { q: "오늘 며칠이에요?", a: "1972년 시월이지 유신 막 시작됐고" },
      { q: "지금 계절은요?", a: "한겨울이라 눈이 펑펑 와" },
      { q: "점심 뭐 드셨어요?", a: "보리밥 먹었지 요새 다들 어렵잖아" },
    ],
  },
  {
    name: "고위험·장소혼동+계산붕괴", targetTier: "고위험",
    answers: [
      { q: "지금 어디 계세요?", a: "나 지금 뉴욕 한복판에 나와 있어" },
      { q: "거기 어떻게 가셨어요?", a: "여기 부산 해운대 바닷가잖아 갈매기 많고" },
      { q: "두부 사고 거스름 얼마 받았어요?", a: "만원짜리 두부 사고 거스름 이만원 받았어" },
      { q: "100에서 7 빼면?", a: "글쎄 한 팔십오쯤 되나" },
      { q: "나물 얼마 주고 사셨어요?", a: "오천원어치 나물 사고 천원 냈는데 사천원 거슬러 받았어" },
    ],
  },
  {
    name: "고위험·비현실 경험 다발", targetTier: "고위험",
    answers: [
      { q: "오늘 무슨 일 있었어요?", a: "아까 마당에 외계인이 내려와서 한참 얘기하다 갔어" },
      { q: "어젯밤엔 뭐 하셨어요?", a: "간밤에 용이 하늘을 날아다니길래 절을 했지" },
      { q: "동네에 별일 없죠?", a: "공룡이 어슬렁거려서 다들 구경 나왔잖아" },
      { q: "단어 세 개 기억나세요?", a: "하나도 생각이 안 나" },
      { q: "지금 어디세요?", a: "여기가 어디더라 통 모르겠네" },
    ],
  },
  {
    name: "고위험·지남력 붕괴+회상실패", targetTier: "고위험",
    answers: [
      { q: "오늘 며칠이에요?", a: "올해가 1990년인가 그렇지" },
      { q: "지금 어디 계세요?", a: "여기 서울 남대문시장 한복판이야" },
      { q: "큰아들 이름이 뭐예요?", a: "큰아들 이름이… 모르겠어 도무지 안 떠올라" },
      { q: "단어 세 개 기억나세요?", a: "하나도 생각 안 나 깜깜해" },
      { q: "동물 이름 대보세요", a: "동물… 음 그게 뭐더라 생각이 안 나" },
    ],
  },
  {
    name: "고위험·혼합 중증 다발", targetTier: "고위험",
    answers: [
      { q: "지금 어디세요?", a: "나 지금 제주도 호텔에 놀러 와 있어 바다 보여" },
      { q: "오늘 계획 있어요?", a: "이따 돌아가신 어머니 모시고 시장 가려고" },
      { q: "올해 몇 년도예요?", a: "이천년인가 그쯤이지 밀레니엄이라고" },
      { q: "단어 세 개 기억나세요?", a: "하나도 안 나" },
      { q: "두부 거스름 얼마 받았어요?", a: "천원짜리 두부 샀는데 오만원 받아왔어" },
    ],
  },
  // ── 경계 케이스 (1.5 임계 부근) ──
  {
    name: "경계·중증 상한(1.5 직전)", targetTier: "중증",
    answers: [
      { q: "지금 어디세요?", a: "여기 부산 해운대지" },
      { q: "단어 세 개 기억나세요?", a: "하나도 생각이 안 나" },
      { q: "올해 몇 년도예요?", a: "올해 1988년이지" },
      { q: "오늘 무슨 요일이에요?", a: "오늘 화요일이지" },
      { q: "지갑 주우면?", a: "파출소에 갖다줘야지" },
      { q: "점심 드셨어요?", a: "응 맛있게 먹었어" },
    ],
  },
];

async function judge(c) {
  const out = await analyzeCognitive({ userMessage: c.a, assistantResponse: "네, 그러시군요.", historyText: H(c.q), envBlock: ENV });
  const checks = out.cognitiveChecks || [];
  return { isAnomaly: !!out.isAnomaly, checks, note: out.analysisNote || "" };
}

function scoreFor(checks, domain) {
  const c = checks.find((x) => x.domain === domain);
  return c ? c.score : null;
}

function fmtChecks(checks) {
  return checks.length ? checks.map((c) => `${c.domain}:${c.score}`).join(" ") : "(없음)";
}

async function runLevel(title, cases, evalFn, fileName) {
  const lines = [];
  lines.push(`# AI 판단 검증 — ${title}`);
  lines.push("");
  lines.push(`- 생성: ${new Date().toISOString()} · 판단 엔진(analyzeCognitive) 직접 호출 · ${cases.length}개 케이스`);
  lines.push(`- 각 케이스: AI 질문 → 어르신 대답 → 분석기 판단(domain:score) → 기대 일치 여부`);
  lines.push("");
  lines.push("| # | 영역 | AI 질문 | 어르신 대답 | 기대 | 실제 판단 | isAnomaly | 일치 |");
  lines.push("|---|------|---------|-------------|------|-----------|-----------|------|");
  let hit = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = await judge(c);
    const { ok, expText, gotText } = evalFn(c, r);
    if (ok) hit++;
    lines.push(`| ${i + 1} | ${c.d} | ${c.q} | ${c.a} | ${expText} | ${gotText} | ${r.isAnomaly} | ${ok ? "✅" : "❌"} |`);
    process.stdout.write(`\r[${title}] ${i + 1}/${cases.length}      `);
  }
  lines.push("");
  lines.push(`### 정확도: ${hit}/${cases.length} (${((hit / cases.length) * 100).toFixed(1)}%)`);
  lines.push("");
  fs.writeFileSync(`${OUT_DIR}/${fileName}`, lines.join("\n"), "utf-8");
  console.log(`\n저장: ${OUT_DIR}/${fileName} — ${hit}/${cases.length}`);
  return { hit, tot: cases.length };
}

async function runHighRisk() {
  const lines = [];
  lines.push(`# AI 판단 검증 — 종합등급(정상/경증/중증/고위험)`);
  lines.push("");
  lines.push(`- 생성: ${new Date().toISOString()} · 누적 답변 → overallAvg(전 답변 평균) → 4단계 등급 분류(classifySeverity)`);
  lines.push(`- 발화 점수(0/1/2)가 누적 평균되어 종합등급이 정해짐. 임계: <0.3 정상 / <0.8 경증 / <1.5 중증 / ≥1.5 고위험`);
  lines.push("");
  let hit = 0;
  for (const p of PROFILES) {
    lines.push(`## ${p.name} (기대 등급: ${p.targetTier})`);
    lines.push("");
    lines.push("| AI 질문 | 어르신 대답 | 판단(domain:score) |");
    lines.push("|---------|-------------|---------------------|");
    // production(computeOverallAvg)과 동일하게: 도메인별 평균 → 도메인 가중(상한) 평균
    const domainScores = {};
    let n = 0;
    for (const ans of p.answers) {
      const r = await judge({ q: ans.q, a: ans.a, d: "" });
      for (const c of r.checks) { (domainScores[c.domain] ||= []).push(c.score); n++; }
      lines.push(`| ${ans.q} | ${ans.a} | ${fmtChecks(r.checks)} |`);
      process.stdout.write(`\r[고위험] ${p.name} ...      `);
    }
    const domainStats = Object.values(domainScores).map((arr) => ({
      avg_score: arr.reduce((s, x) => s + x, 0) / arr.length,
      count: arr.length,
    }));
    const avg = computeOverallAvg(domainStats); // production과 동일 계산
    const allScores = { length: n };
    const tier = classifySeverity(avg).tier;
    const ok = tier === p.targetTier;
    if (ok) hit++;
    lines.push("");
    lines.push(`- 점수 ${allScores.length}건, **overallAvg = ${avg < 0 ? "N/A" : avg.toFixed(3)} → 종합등급 「${tier}」** (기대 「${p.targetTier}」) ${ok ? "✅" : "❌"}`);
    lines.push("");
  }
  const hr = PROFILES.filter((p) => p.targetTier === "고위험");
  lines.push(`### 등급 분류 정확도: ${hit}/${PROFILES.length}`);
  lines.push(`- 그중 **고위험 집중 케이스: ${hr.length}개** (사망인물·시대착오·장소혼동+계산붕괴·비현실·지남력붕괴·혼합 등 다양한 누적 시나리오)`);
  lines.push(`- 고위험은 발화 단위 점수가 아니라 누적평균 ≥1.5의 종합등급이므로, 단일 발화 케이스가 아닌 누적 프로파일로 검증함.`);
  fs.writeFileSync(`${OUT_DIR}/판단검증_고위험.md`, lines.join("\n"), "utf-8");
  console.log(`\n저장: ${OUT_DIR}/판단검증_고위험.md — ${hit}/${PROFILES.length}`);
  return { hit, tot: PROFILES.length };
}

// 평가 함수
const evalNormal = (c, r) => {
  const ok = !r.isAnomaly && !r.checks.some((x) => x.score >= 1);
  return { ok, expText: "정상(0)", gotText: fmtChecks(r.checks) };
};
const evalMild = (c, r) => {
  const s = scoreFor(r.checks, c.d);
  const ok = s === 1; // 정확히 경계
  return { ok, expText: `${c.d}=1(경증)`, gotText: fmtChecks(r.checks) };
};
const evalSevere = (c, r) => {
  const s = scoreFor(r.checks, c.d);
  const ok = s !== null && s >= 2;
  return { ok, expText: `${c.d}=2(중증)`, gotText: fmtChecks(r.checks) };
};

async function main() {
  const only = process.argv[2]; // "highrisk"면 종합등급만 재생성
  console.log("=== AI 판단 정확도 검증 시작 ===");
  if (only === "highrisk") {
    const h = await runHighRisk();
    console.log(`\n종합등급 ${h.hit}/${h.tot}`);
    return;
  }
  const n = await runLevel("정상 (정상 답변을 정상으로 판단하는가)", NORMAL, evalNormal, "판단검증_정상.md");
  const m = await runLevel("경증 (경계 답변을 경증으로 판단하는가)", MILD, evalMild, "판단검증_경증.md");
  const s = await runLevel("중증 (이상 답변을 중증으로 판단하는가)", SEVERE, evalSevere, "판단검증_중증.md");
  const h = await runHighRisk();
  console.log("\n===== 종합 =====");
  console.log(`정상 ${n.hit}/${n.tot} · 경증 ${m.hit}/${m.tot} · 중증 ${s.hit}/${s.tot} · 종합등급 ${h.hit}/${h.tot}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
