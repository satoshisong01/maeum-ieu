/**
 * 안전 판정 계층 적대 배터리 — 응급·모더레이션·사투리 정규식의 미탐/오탐을 양방향으로 측정.
 *
 * 이 프로젝트의 최대 결함 원인은 "죽은 정규식"이다(한국어 활용형·조사·부사 삽입).
 * 실패가 로그에 남지 않아 기능이 조용히 멈추므로, 케이스를 고정해 회귀를 막는다.
 * 각 미탐마다 SOFT_SIGNAL 백스톱 도달 여부를 함께 표시 — "완전 침묵"과 "백스톱 구제"를 구분한다.
 *
 * 사용: npx tsx scripts/regex-battery.ts
 */
import { detectEmergency } from "../lib/chat/emergency";
import { SOFT_SIGNAL } from "../lib/chat/emergency-llm";
import { detectInappropriate } from "../lib/chat/moderation";
import { normalizeDialect } from "../lib/chat/dialect-normalize";

type Row = { t: string; want: "L0" | "L2+" | "L3"; note: string };

/** 오탐 후보 — 정상 발화가 응급/부적절로 잡히면 허위 보호자 알림 또는 대화 차단 */
const FP: Row[] = [
  { t: "병원 예약 시간이라 빨리 가야 해", want: "L0", note: "C3 완곡표현 단독" },
  { t: "장 문 닫기 전에 어서 가야지", want: "L0", note: "C3" },
  { t: "나 먼저 가야 해서 이만 끊을게", want: "L0", note: "C3" },
  { t: "이 동네는 시끄러워서 살기 싫어", want: "L0", note: "M5 장소 목적어" },
  { t: "아파트에서 그만 살고 싶어 주택 가려고", want: "L0", note: "M5" },
  { t: "그 가방은 짐이 되니까 두고 왔어", want: "L0", note: "M5 사물" },
  { t: "감기약 먹고 푹 자버리면 낫겠지", want: "L0", note: "H1 정상 복약+수면" },
  { t: "수면제 먹고 잠들면 좀 낫지", want: "L0", note: "H1" },
  { t: "약을 많이 먹으면 속이 안 좋아", want: "L0", note: "H2 일반론" },
  { t: "옆집 할머니가 약을 잘못 먹고 실려 갔대", want: "L0", note: "C4 제3자" },
  { t: "노인정에서 어떤 할머니가 죽고 싶다고 그러더라", want: "L0", note: "C4 제3자" },
];

/** 미탐 후보 — 위급인데 놓치면 알림이 안 감 */
const FN: Row[] = [
  { t: "숨이 턱 막혀서 못 견디겠어", want: "L3", note: "C5 부사 삽입" },
  { t: "숨이 턱턱 막히네", want: "L3", note: "C5" },
  { t: "숨쉬기가 힘들어요", want: "L3", note: "C5 조사" },
  { t: "숨을 제대로 못 쉬겠어", want: "L3", note: "C5" },
  { t: "오른팔이 갑자기 안 움직여", want: "L3", note: "C6 편측 마비(뇌졸중)" },
  { t: "왼손이 마비된 것 같아", want: "L3", note: "C6" },
  { t: "오른팔에 힘이 하나도 없어", want: "L3", note: "C6" },
  { t: "말이 좀 어눌해", want: "L3", note: "C6 부사 삽입" },
  { t: "계단에서 미끄러져서 팔을 다쳤어", want: "L2+", note: "H4 낙상" },
  { t: "화장실에서 넘어졌어", want: "L2+", note: "H4" },
  { t: "피가 멈추지 않아", want: "L2+", note: "H4 출혈" },
  { t: "피를 많이 흘렸어", want: "L2+", note: "H4" },
  { t: "쓰러질 거 같아", want: "L2+", note: "H4 것→거" },
  { t: "아이고 사람 살려", want: "L2+", note: "M13 구조 요청" },
  { t: "앰뷸런스 불러줘", want: "L2+", note: "M14" },
  { t: "가슴이 좀 답답하고 식은땀이 줄줄 나", want: "L3", note: "H3 심근경색 조합" },
  { t: "머리가 너무 아프네", want: "L2+", note: "M1" },
  { t: "사흘째 잠을 못 자", want: "L2+", note: "M15 L1 누적" },
];

/** 모더레이션 오탐 — 정상 대화가 차단되면 어르신 체감 피해 */
const MOD_FP = [
  { t: "당뇨병 신경이 안 좋아서 발이 저려", note: "C7 병+신" },
  { t: "지병 신경 쓰여서 잠이 안 와", note: "C7" },
  { t: "마늘 껍질 벗겨서 넣었어", note: "H5 요리" },
  { t: "땀 나서 옷 벗고 씻었어", note: "H5 위생" },
  { t: "음 탕국 끓였어", note: "H6 STT 필러" },
  { t: "옛날엔 설날에 떡을 쳐서 먹었지", note: "H7 떡메질" },
  { t: "넘어져서 엉덩이 만지면 아파", note: "H8 낙상 보고" },
  { t: "가슴 사진 보여줬어", note: "H8 흉부 X-ray" },
  { t: "고추씨 팔러 갔어", note: "C7 씨팔" },
  { t: "우리 개 새끼가 다섯 마리야", note: "C7" },
];

let f = 0, p = 0;
const chk = (ok: boolean) => { ok ? p++ : f++; return ok ? "✓" : "✗"; };

console.log("── 응급 오탐(정상 발화가 L2+ 되면 허위 알림) ──");
for (const r of FP) {
  const d = detectEmergency(r.t);
  console.log(`  ${chk(d.level === 0)} L${d.level} ${String(d.category).padEnd(16)} [${r.note}] "${r.t}"`);
}
console.log("\n── 응급 미탐(정규식 / SOFT_SIGNAL 백스톱 도달) ──");
for (const r of FN) {
  const d = detectEmergency(r.t);
  const want = r.want === "L3" ? 3 : 2;
  const soft = SOFT_SIGNAL.test(r.t);
  const ok = d.level >= want;
  // 정규식이 놓쳐도 백스톱이 도달하면 '부분 구제'
  console.log(`  ${chk(ok)} L${d.level} 백스톱=${soft ? "도달" : "침묵"} [${r.note}] "${r.t}"`);
}
console.log("\n── 모더레이션 오탐(정상 발화가 차단) ──");
for (const r of MOD_FP) {
  const m = detectInappropriate(r.t);
  console.log(`  ${chk(m.category === "ok")} ${String(m.category).padEnd(10)} [${r.note}] "${r.t}"`);
}
console.log("\n── 사투리 정규화가 정상 발화를 망가뜨리는가 ──");
for (const t of ["민지야 고마워", "겁나서 못 갔어", "마이크 잡고 노래했어", "고맙습니다"]) {
  const n = normalizeDialect(t);
  const changed = n.changes.length > 0;
  console.log(`  ${chk(!changed || n.normalized === t)} ${changed ? "변환" : "무변환"} "${t}" → "${n.normalized}"`);
}
console.log(`\n${p}/${p + f} passed, ${f} FAILED`);
