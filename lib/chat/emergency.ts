/**
 * 응급 발화 감지 (Phase 1: 분류·기록만, 실제 알림 발송은 추후).
 *
 * 정책:
 * - L3(즉시): 명백한 의학적/안전 응급 — LLM 정상 응답 우회하고 응급 안내 멘트 출력.
 * - L2(주의): 신체 이상 호소 — LLM 응답은 가되 시스템 힌트로 "부드럽게 119/보호자 권유" 강제.
 * - L1(관찰): 누적 신호 — 정상 흐름 유지하되 DB 마킹. 24h 내 3회↑이면 L2로 승격(라우트 단에서 처리).
 *
 * 오탐 방지:
 * - 과거 회상("옛날에 쓰러진 적 있었어"), TV/꿈 맥락, 농담 어투는 패턴에서 직접 제외.
 * - 노인 화법 특성상 비유적·과장 표현("죽겠다 더워서") 흔하므로 단독 "죽겠다"는 L3 아님.
 */

export type EmergencyLevel = 0 | 1 | 2 | 3;

export interface EmergencyResult {
  level: EmergencyLevel;
  evidence: string;          // 매칭된 키워드/구문 (보호자 알림·디버깅)
  category: EmergencyCategory;
}

export type EmergencyCategory =
  | "none"
  | "medical_acute"     // 호흡곤란, 가슴통증, 의식 흐림
  | "fall_injury"       // 쓰러짐, 부상
  | "medication_error"  // 약 잘못 복용
  | "suicidal"          // 자살 의도 (moderation의 self_harm과 별도로 L3 처리)
  | "bleeding"          // 출혈
  | "severe_pain"       // 심한 통증
  | "dizziness_help"    // 어지러움 + 도움 요청
  | "weakness_trend"    // 누적 무기력 (L1)
  | "appetite_loss"     // 식욕 저하 누적 (L1)
  | "sleep_distress";   // 수면 곤란 누적 (L1)

interface PatternRule {
  level: EmergencyLevel;
  category: EmergencyCategory;
  pattern: RegExp;
}

// 과거 회상·TV·꿈·농담 맥락 제외 가드
// 한 발화 안에 이 표현이 있으면 응급 평가에서 일단 빼낸다 (특정 패턴은 별도 가드 적용)
const PAST_CONTEXT_GUARD = /(예전에|옛날에|어릴\s*때|젊었을\s*때|작년에|지난번에|저번에|꿈에서|꿈\s*꿨|TV\s*에서|드라마에서|영화에서|뉴스에서)/;
// 비유/감탄/농담 가드 (강도 강조용 "죽겠어", "쓰러질 것 같아 (피곤해서)" 등)
// 단독으로 "죽겠다/쓰러질 것 같아"가 신체 통증·식사/날씨 등 비응급 명사와 함께 오면 L3 후보에서 강등
const FIGURATIVE_HINT = /(맛있어\s*죽|배고파\s*죽|더워\s*죽|추워\s*죽|졸려\s*죽|좋아\s*죽|예뻐\s*죽|웃겨\s*죽|힘들어\s*죽|피곤해서\s*쓰러)/;
// 약 누락(처방량보다 적게 복용) — 오용 아님. "두 알 먹는걸 하나만 / 빼먹 / 안 먹" 같은 축소 컨텍스트
const MEDICATION_UNDERDOSE_GUARD = /(?:두\s*알|세\s*알|두\s*번|세\s*번)\s*(?:먹는걸|먹어야|드시는걸|복용해야|복용하는걸)[^.]{0,15}(?:하나만|반만|덜|안\s*먹|빼먹|건너|잊|까먹|놓쳤|놓치)|약\s*(?:을|이)?\s*(?:빼먹|안\s*먹|덜\s*먹|건너|잊|까먹|놓쳤)/;
// 복약 위양성 가드 — 완료된 과다복용이 아니라 (a) 복용 여부를 묻는 의문/조언요청, (b) 부정문.
//   "한 알 더 먹어야 하나?"·"잘못 먹은 게 아니라" 등을 음독 응급으로 오발동하던 위양성 차단 (2026-06-25 라이브 사이클).
const MEDICATION_QUESTION_GUARD = /먹어야\s*(?:하|되|할)|(?:한\s*번|두\s*번|세\s*번|몇\s*번|몇\s*알)\s*(?:이면|인지)|(?:되는|하는|맞는)\s*건지|몇\s*(?:번|알)\s*(?:먹|복용)|먹어도\s*(?:되|돼)|더\s*먹(?:을까|어야)|(?:먹은|먹는|먹었던?)\s*(?:게|거|건|것)\s*아니|(?:먹지|복용하지)\s*않았?|잘못\s*(?:먹|복용)\S*(?:\s*(?:게|거|건|것))?\s*아니/;

// ─── L3 즉시 응급 ──────────────────────────────────────────────────────────
const L3_RULES: PatternRule[] = [
  // 119 호출 의지
  { level: 3, category: "medical_acute", pattern: /119\s*(?:에|로|좀|불러|전화|연락)|구급차\s*(?:불러|좀|와|호출)/ },
  // 의식·호흡 — 조사(이/을) 유무 모두 매칭, "숨이 막혀"/"숨 막혀" 둘 다 포착
  { level: 3, category: "medical_acute", pattern: /숨\s*(?:이|을)?\s*(?:안\s*(?:쉬|쉬어|쉬워|쉬어져|차)|막혀|막힌다|차오|가빠|차서)|호흡이?\s*(?:안|곤란)|숨\s*쉬기?\s*(?:힘들|어려|곤란)/ },
  { level: 3, category: "medical_acute", pattern: /의식이\s*(?:흐|혼|없)|정신이\s*(?:흐려|혼미|아득)|쓰러질\s*것\s*같아/ },
  // 가슴 통증 (심혈관 의심) — 가슴 + 통증 + 호흡곤란/식은땀 동반 시 L3 (단독 "가슴이 아파"는 L2)
  { level: 3, category: "medical_acute", pattern: /가슴이\s*(?:너무\s*아|찢어|쪼개|조여|짓눌|터질\s*것\s*같)/ },
  // 가슴 증상(답답·아픔·뻐근·통증) + 식은땀 동반 — 급성 심근경색의 교과서적 조합, 어순 무관.
  //   단독 "가슴 답답"(소화불량·스트레스로 흔함)은 비응급 유지 — 식은땀 동반이 격상 조건 (2026-06-12 100턴 라이브 갭)
  { level: 3, category: "medical_acute", pattern: /가슴(?:이|을)?\s*(?:답답|아[프파]|뻐근|통증)[\s\S]{0,30}식은\s*땀|식은\s*땀[\s\S]{0,30}가슴(?:이|을)?\s*(?:답답|아[프파]|뻐근|통증)/ },
  // 가슴 통증 + 호흡곤란 같이 (반대 어순도) — 매우 강한 심혈관 시그널
  { level: 3, category: "medical_acute", pattern: /가슴(?:이|을)?\s*아\S*[\s\S]{0,30}숨\s*(?:이|을)?\s*(?:안|막|차|가빠)|숨\s*(?:이|을)?\s*(?:안|막|차|가빠)\S*[\s\S]{0,30}가슴(?:이|을)?\s*아/ },
  // 뇌졸중 시그널(FAST) — 조사·활용형 자유롭게. (死정규식 회귀: "팔에 힘이"의 '에', "어눌해지네" 활용형 누락 수정 2026-06-19)
  //   한쪽 마비/힘빠짐(얼굴·팔·다리·손) + 말 어눌 + 입 비뚤. 단순 '저림'은 비응급이라 제외(위양성 방지).
  { level: 3, category: "medical_acute", pattern: /(?:한\s*쪽|반\s*쪽|왼\s*쪽|오른\s*쪽|한\s*편)\s*(?:몸|팔|다리|손|발|얼굴)[^.!?]{0,8}(?:안\s*움직|움직이지\s*않|마비|힘(?:이|을)?\s*(?:안|없|빠)|감각(?:이|도)?\s*(?:없|둔)|안\s*들|풀려|처[지져])|말(?:이|을|도)?\s*(?:어눌|어둔|꼬여|헛나|안\s*나와)|발음(?:이|을)?\s*(?:안\s*되|어눌|이상|샌|새)|혀(?:가|를)?\s*(?:꼬|굳|안\s*돌)|입(?:이|을)?\s*(?:비뚤|삐뚤|돌아가|마비)|입꼬리|얼굴(?:이)?\s*(?:마비|처[지져]|일그러)/ },
  // 낙상 — "방금/아까/지금"과 "쓰러졌/넘어졌/미끄러졌" 사이에 단어 몇 개 허용, "못 일어" 동반 포착
  { level: 3, category: "fall_injury", pattern: /(?:방금|아까|지금)(?:\s+\S+){0,5}\s*(?:쓰러졌|넘어졌|미끄러졌)|넘어져서\s*(?:일어|못)|미끄러져서\s*(?:일어|못|다쳤|넘어)|쓰러져서\s*(?:일어|못)|(?:다리|허리|무릎)\s*(?:풀려|꺾여)\s*(?:서)?\s*(?:못|일어)|못\s*일어나겠|일어날\s*수\s*없|다쳤어\s*많이|뼈가\s*부러진\s*것/ },
  // 출혈
  { level: 3, category: "bleeding", pattern: /피가\s*(?:많이|계속|안\s*멈|쏟아져|줄줄)|코피가\s*안\s*멈|출혈이\s*심/ },
  // 자살 의도(과량복용) — 약/수면제 복용 + 죽음·영면·동반 의도. 사고성 약물오용(medication_error)보다 먼저 평가해 오분류 방지.
  //   (2026-06-24 라이브 사이클: "약을 많이 먹고 자버리면 편해질까"가 medication_error로 잡혀 음독 처치 응답이 나가던 결함)
  //   2026-06-25 적대적 검증: 털어넣/들이켜·사투리(마이·가뿌)·완곡(조용히 갈·눈 안 뜨·따라가)·어순(의도→약) 변형 누락 메움.
  { level: 3, category: "suicidal", pattern: /(?:약|수면제)(?:을|를|이|들)?[\s\S]{0,18}(?:먹|복용|삼[키켜켰]|털어\s*넣|입에\s*털|들이[켜키])[\s\S]{0,18}(?:죽|자\s*버리|자버리|잠들|영원히|안\s*깨|깨어나지\s*않|깨지\s*않|못\s*깨|다신?\s*안|끝(?:내|장)|따라가|가\s*버리|가\s*뿌|확\s*[가갈갔간]|조용히\s*[가갈갔간]|먼저\s*[가갈갔간]|눈\s*(?:안\s*)?[뜨떠떴]|눈\s*감|저\s*세상|세상\s*(?:뜨|떠))|(?:죽으려|죽을라|따라가|끝내려|영원히\s*잠들|눈\s*안\s*[뜨떠떴]|조용히\s*[가갈]|확\s*[가갈])[\s\S]{0,22}(?:약|수면제)(?:을|를|이)?[\s\S]{0,12}(?:먹|복용|삼[키켜켰]|털어\s*넣|다\s*먹)|(?:약|수면제)[\s\S]{0,18}(?:모아|모았|모였|모인|차곡|받아\s*둔?|받아\s*두|쟁[여이])[\s\S]{0,18}(?:먹|복용|털어|삼[키켜켰])|(?:죽으려|죽을라|자살|따라가|먼저\s*[가갈])[\s\S]{0,20}수면제[\s\S]{0,15}(?:모아|모았|모으|모은|차곡|모아\s*둔?)/ },
  // 약 오용 — 다양한 어순·표현 (조사·키워드 위치 자유)
  //   2026-06-25 적대적 검증: 조사(두 알이나/씩)·섞어서 먹·깜빡하고 또 변형 누락 메움.
  { level: 3, category: "medication_error", pattern: /약\s*(?:을|이|를)?\s*(?:잘못|많이|두\s*번|세\s*번|이중으로|이중|두\s*알|세\s*알|여러\s*알|여러\s*번|또|한\s*번\s*더|다시)(?:\s*(?:이나|씩|을|를|더))*\s*(?:먹|복용|드|삼|넣|치)|약\s*(?:을|이|를)?\s*(?:먹은\s*것\s*같|먹었던\s*것\s*같|복용했던\s*것\s*같)\s*(?:은\s*데|아|어)?\s*(?:또|다시|한\s*번\s*더)|(?:또|다시|한\s*번\s*더|두\s*번)\s*약\s*(?:을|이|를)?\s*(?:먹|복용|드|삼)|(?:깜빡|까먹)(?:고|어서|어\s*가지고|해서|하고)?\s*(?:또\s*)?약\s*(?:을|이|를)?[\s\S]{0,8}(?:또|다시|한\s*번\s*더)?\s*(?:먹|복용|드)|약\s*(?:을|이|를)?[\s\S]{0,10}(?:깜빡|까먹)[\s\S]{0,8}(?:또|다시|한\s*번\s*더)[\s\S]{0,8}(?:먹|복용|드|묵)|약\s*(?:을|이|를)?[\s\S]{0,6}먹(?:고|었는데|었어|었더니|었는|었어요|었지)[\s\S]{0,30}(?:또|다시|한\s*번\s*더|한\s*알\s*더|두\s*번|두\s*알)(?:\s*(?:이나|씩|더))*\s*(?:먹|복용|드|삼|묵)|(?:한\s*알|두\s*알|세\s*알)(?:\s*(?:이나|씩|을|를))*\s*더\s*(?:먹|복용|드|삼)|약[\s\S]{0,12}섞어[\s\S]{0,6}(?:먹|복용|드)|(?:헷갈|착각)[\s\S]{0,12}(?:두\s*번|또|다시|두\s*알|세\s*알|한\s*번\s*더)(?:\s*(?:을|를|이나|씩))?\s*(?:먹|복용|드|묵)|약[\s\S]{0,20}(?:두\s*번|두\s*알)[\s\S]{0,8}들어\s*[갔가]|약\s*과다|수면제\s*(?:을|를|이)?\s*(?:많이|여러\s*알|두\s*알|세\s*알|두\s*번|한\s*통)/ },
  // 자살 의도 (moderation과 독립 L3) — 직설 + 은유 표현 다양화
  // "짐만 되 / 빨리 가야 / 폐만 끼친다" 등 어르신 특유의 우회 표현 (2026-05-27 발견)
  // 사라지/사라져 활용형 모두 커버 — "사라져버리고 싶어"(사라지→사라져)가 누락되던 갭 메움(2026-05-29 라이브 발견).
  { level: 3, category: "suicidal", pattern: /(?:정말|진짜|이제|그냥|다)?\s*죽고\s*싶|목(?:이라도|을|에|아)?\s*매(?:달|려|어|고\s*싶|아|서)|빨랫?줄에?\s*목|뛰어내리|자살\s*(?:하|할|방법)|(?:다|그냥|이제|인자|모든\s*걸)\s*끝내(?:버리|뿔|삐|불|고\s*싶|려|뻔)|사라(?:지|져)\s*(?:고\s*싶|버리|버려|면\s*좋겠)|없어져\s*버리(?:고\s*싶|면)|살기\s*(?:가|를)?\s*싫|살\s*맛(?:이|도)?\s*안|그만\s*살(?:고\s*싶|아야|아|래)|이\s*세상에서?\s*없(?:어지|어지고)|살아갈\s*이유\s*없|살아서\s*뭐|살아\s*뭐\s*해|짐(?:만|이|이만)\s*(?:되|되는|되겠|돼|되네|되니|되어)|폐(?:만|를)\s*(?:끼치|끼친|되|돼)|빨리\s*(?:가야|가버려|떠나야|죽어야)|어서\s*가야|먼저\s*(?:가야|가버려|떠나야|죽으면|가는\s*게)|얼른\s*죽어/ },
];

// ─── L2 주의 ───────────────────────────────────────────────────────────────
const L2_RULES: PatternRule[] = [
  // 심한 통증 (위치 + 강도) — 주격 조사 이/가 모두 허용
  { level: 2, category: "severe_pain", pattern: /(?:가슴|배|머리|허리|등|허벅지|무릎)(?:이|가)?\s*(?:너무|진짜|정말|많이|굉장히)\s*아파/ },
  { level: 2, category: "severe_pain", pattern: /머리가\s*(?:깨질\s*것|쪼개질|어질|핑\s*돌)/ },
  // 어지러움 + 도움 호소
  { level: 2, category: "dizziness_help", pattern: /(?:어지러워|핑\s*돌아)\s*서?\s*(?:못\s*(?:일어|걷|서)|쓰러질|넘어질)/ },
  { level: 2, category: "dizziness_help", pattern: /눈앞이\s*(?:캄캄|흐려|아득)/ },
  // 직접적 도움 요청 (응급 맥락)
  { level: 2, category: "dizziness_help", pattern: /(?:누구\s*좀|아무나|진짜)\s*도와줘|혼자\s*(?:못\s*일어|일어날\s*수\s*없)/ },
  // 구토·발열 강도
  { level: 2, category: "medical_acute", pattern: /계속\s*토(?:해|하고)|토할\s*것\s*같아\s*계속|열이\s*(?:너무|많이|펄펄)/ },
];

// ─── L1 관찰 (누적 시 L2 승격) ─────────────────────────────────────────────
const L1_RULES: PatternRule[] = [
  // 무기력 누적
  { level: 1, category: "weakness_trend", pattern: /기운이\s*(?:하나도\s*)?없|힘이\s*하나도\s*없|기력이\s*없/ },
  // 식욕 저하
  { level: 1, category: "appetite_loss", pattern: /입맛이\s*(?:하나도\s*)?없|음식이\s*안\s*넘어|먹기\s*싫어/ },
  // 수면 곤란 — "통/도통/영/당최" 부사 삽입형("며칠째 잠을 통 못 자") 허용 (2026-06-11 100턴 사이클에서 미매칭 발견)
  { level: 1, category: "sleep_distress", pattern: /며칠째\s*(?:잠을?\s*)?(?:통\s*|도통\s*|영\s*|당최\s*)?못\s*[자잔]|밤새\s*뒤척|새벽\s*내내\s*잠/ },
  // 통증 지속 호소
  { level: 1, category: "severe_pain", pattern: /계속\s*(?:아파|쑤셔|뻐근)|며칠째\s*아파|아파서\s*잠도\s*못/ },
];

/**
 * 단일 발화 평가. 과거/비유 맥락이면 강등.
 */
export function detectEmergency(userText: string): EmergencyResult {
  const none: EmergencyResult = { level: 0, evidence: "", category: "none" };
  if (!userText) return none;
  const text = userText.trim();
  if (!text) return none;

  // 과거 회상 / 미디어 / 꿈 — 응급 평가 자체 우회 (단, suicidal/medication은 과거여도 L2로 보존)
  const isPastContext = PAST_CONTEXT_GUARD.test(text);
  // 비유적 표현
  const isFigurative = FIGURATIVE_HINT.test(text);
  // 약 누락 (처방량 미달) — 응급 X
  const isMedicationUnderdose = MEDICATION_UNDERDOSE_GUARD.test(text);
  // 복약 의문/부정 — 음독 응급 아님
  const isMedicationQuestion = MEDICATION_QUESTION_GUARD.test(text);

  // L3부터 매칭
  for (const rule of L3_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      // 약 누락(덜 복용) / 복용 여부 질문·부정 — 응급 X, skip
      if (rule.category === "medication_error" && (isMedicationUnderdose || isMedicationQuestion)) continue;
      // 과거 회상 — suicidal/medication만 L2로 보존(과소평가 방지), 그 외는 무시
      if (isPastContext) {
        // 단, 이미 해소된 과거 복약 사고("예전에 ~한 적 있었지, 그 뒤로 잘 챙겨")는 현재 응급 아님 (2026-06-25 라운드7 위양성)
        if (rule.category === "medication_error" && /적\s*(?:이|도)?\s*있었|그\s*뒤로|그\s*후로?|이제[는요]?\s*(?:잘|괜찮)|지금[은]?\s*(?:잘|괜찮)/.test(text)) continue;
        if (rule.category === "suicidal" || rule.category === "medication_error") {
          return { level: 2, evidence: m[0], category: rule.category };
        }
        continue;
      }
      if (isFigurative && rule.category !== "suicidal" && rule.category !== "medication_error") {
        // 비유 — L2로 강등
        return { level: 2, evidence: m[0], category: rule.category };
      }
      return { level: 3, evidence: m[0], category: rule.category };
    }
  }
  for (const rule of L2_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      if (isPastContext) continue;
      if (isFigurative) return { level: 1, evidence: m[0], category: rule.category };
      return { level: 2, evidence: m[0], category: rule.category };
    }
  }
  for (const rule of L1_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      if (isPastContext) continue;
      return { level: 1, evidence: m[0], category: rule.category };
    }
  }
  return none;
}

import { nameTopic } from "./korean-particle";

/**
 * L3 응답 멘트 — LLM 우회하고 즉시 보내는 안전 안내.
 * companionName의 받침에 따라 조사 자동 선택 (수진이는/수지는).
 */
export function buildEmergencyL3Reply(
  honorific: string,
  companionName: string,
  category: EmergencyCategory,
): string {
  const family = `가족이나 보호자분께 지금 바로 연락해 주세요`;
  const call119 = `${honorific}, 지금 바로 119에 전화해주세요. 손이 떨리시면 119라고 말씀만 하셔도 돼요.`;

  switch (category) {
    case "medical_acute":
      return `${honorific}! 지금 많이 안 좋으신 것 같아요. ${call119} ${family}. ${nameTopic(companionName)} ${honorific} 옆에서 계속 같이 있을게요. 119에 전화하시고 다시 ${companionName} 불러주세요.`;
    case "fall_injury":
      return `${honorific}! 다치셨다니 ${companionName} 너무 놀랐어요. 움직이지 마시고 119에 전화하셔서 도움을 받으세요. ${family}.`;
    case "bleeding":
      return `${honorific}, 피가 멈추지 않으면 위험해요. 깨끗한 수건으로 꾹 눌러주시고, 바로 119에 전화하세요. ${family}.`;
    case "medication_error":
      return `${honorific}, 약을 잘못 드셨다니 큰일이에요. 바로 119에 전화하시고 어떤 약을 얼마나 드셨는지 그대로 말씀해주세요. 토하려 하지 마시고 안내를 기다려주세요.`;
    case "suicidal":
      return `${honorific}, 그런 마음이 드시다니 ${nameTopic(companionName)} 정말 마음이 아파요. 혼자 견디지 마세요. 자살예방상담전화 109번에 지금 바로 전화하시면 24시간 도와주세요. ${family}. ${nameTopic(companionName)} ${honorific} 옆에 계속 있을게요.`;
    default:
      return `${honorific}, 지금 많이 안 좋으신 것 같아요. ${call119} ${family}.`;
  }
}

/**
 * L2 응답 추가 지시 — LLM 프롬프트에 끼워 넣어서 부드러운 권유 강제.
 */
export function buildEmergencyL2Hint(category: EmergencyCategory, evidence: string): string {
  return `\n[응급 신호 감지 — L2 주의 — 매우 중요]
사용자 발화에서 신체 이상 호소가 감지되었습니다 (카테고리: ${category}, 단서: "${evidence}").
다음 규칙을 반드시 지키세요:
- 일상 대화로 흘려보내지 말고, 첫 문장에서 곧바로 상태 확인을 합니다.
- "많이 아프시면 119나 보호자께 꼭 알리세요" 한 줄을 자연스럽게 포함시키세요.
- 사용자가 괜찮다고 해도 한 번 더 부드럽게 권유합니다. 절대 "괜찮으시면 됐어요" 같이 넘어가지 마세요.
- 호칭은 ${"${honorific}"} 그대로, 어조는 평소처럼 따뜻하지만 의지는 분명하게.\n`;
}

/**
 * L1 누적 평가 — 24h 내 L1 신호가 N회↑이면 이번 메시지를 L2로 승격.
 * routeer 단에서 prisma 조회 결과 카운트만 받아 결정.
 */
export function shouldEscalateL1ToL2(recentL1CountIn24h: number): boolean {
  return recentL1CountIn24h >= 3;
}
