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

// ─── L3 즉시 응급 ──────────────────────────────────────────────────────────
const L3_RULES: PatternRule[] = [
  // 119 호출 의지
  { level: 3, category: "medical_acute", pattern: /119\s*(?:에|로|좀|불러|전화|연락)|구급차\s*(?:불러|좀|와|호출)/ },
  // 의식·호흡 — 조사(이/을) 유무 모두 매칭, "숨이 막혀"/"숨 막혀" 둘 다 포착
  { level: 3, category: "medical_acute", pattern: /숨\s*(?:이|을)?\s*(?:안\s*(?:쉬|쉬어|쉬워|쉬어져|차)|막혀|막힌다|차오|가빠|차서)|호흡이?\s*(?:안|곤란)|숨\s*쉬기?\s*(?:힘들|어려|곤란)/ },
  { level: 3, category: "medical_acute", pattern: /의식이\s*(?:흐|혼|없)|정신이\s*(?:흐려|혼미|아득)|쓰러질\s*것\s*같아/ },
  // 가슴 통증 (심혈관 의심) — 가슴 + 통증 + 호흡곤란/식은땀 동반 시 L3 (단독 "가슴이 아파"는 L2)
  { level: 3, category: "medical_acute", pattern: /가슴이\s*(?:너무\s*아|찢어|쪼개|조여|짓눌|터질\s*것\s*같)/ },
  // 가슴 통증 + 호흡곤란 같이 (반대 어순도) — 매우 강한 심혈관 시그널
  { level: 3, category: "medical_acute", pattern: /가슴(?:이|을)?\s*아\S*[\s\S]{0,30}숨\s*(?:이|을)?\s*(?:안|막|차|가빠)|숨\s*(?:이|을)?\s*(?:안|막|차|가빠)\S*[\s\S]{0,30}가슴(?:이|을)?\s*아/ },
  // 뇌졸중 시그널
  { level: 3, category: "medical_acute", pattern: /(?:한\s*쪽|반\s*쪽|왼\s*쪽|오른\s*쪽)\s*(?:몸|팔|다리)이?\s*(?:안\s*움직|마비|힘이\s*안)|말이\s*어눌해져|입이\s*비뚤/ },
  // 낙상 — "방금/아까/지금"과 "쓰러졌" 사이에 짧은 부사구가 끼일 수 있어 단어 몇 개 허용
  { level: 3, category: "fall_injury", pattern: /(?:방금|아까|지금)(?:\s+\S+){0,4}\s*쓰러졌|넘어져서\s*(?:일어|못)|미끄러져서\s*다쳤|다쳤어\s*많이|뼈가\s*부러진\s*것/ },
  // 출혈
  { level: 3, category: "bleeding", pattern: /피가\s*(?:많이|계속|안\s*멈|쏟아져|줄줄)|코피가\s*안\s*멈|출혈이\s*심/ },
  // 약 오용
  { level: 3, category: "medication_error", pattern: /약\s*(?:을|이|두)\s*(?:잘못|많이|두\s*번|이중으로|섞어)\s*(?:먹|복용|드)|약\s*과다|수면제\s*(?:많이|여러\s*알)/ },
  // 자살 의도 (moderation과 독립 L3)
  { level: 3, category: "suicidal", pattern: /(?:정말|진짜|이제)\s*죽고\s*싶|목\s*매(?:달|려|어)|뛰어내리|자살\s*(?:하|할|방법)/ },
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
  // 수면 곤란
  { level: 1, category: "sleep_distress", pattern: /며칠째\s*(?:잠을\s*)?못\s*자|밤새\s*뒤척|새벽\s*내내\s*잠/ },
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

  // L3부터 매칭
  for (const rule of L3_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      // 과거 회상 — suicidal/medication만 L2로 보존(과소평가 방지), 그 외는 무시
      if (isPastContext) {
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
