/**
 * 부적절 발언(성적 농담·욕설·혐오) 1차 필터.
 *
 * 정책:
 * - LLM 호출 전 키워드/패턴 기반으로 명백한 부적절 발언을 감지한다.
 * - 첫 1회는 부드러운 환기, 2회 이상은 단호한 거절로 단계적 대응.
 * - 정상 대화 손상이 없도록 보수적 키워드만 사용. 의학·신체 부위는 의료 맥락이라 제외.
 * - 사용자가 노인이므로 톤은 부드럽되 의지는 분명하게.
 */

// 한국어 조사 공용 helper
import { nameTopic, nameSubj, iGa, eunNeun } from "./korean-particle";

// 명백한 성적/외설 의도 표현. 일반 대화에서 거의 안 쓰이는 강한 표현만.
const SEXUAL_EXPLICIT = [
  // 직접적 외설 (강한 표현)
  /자\s*위/i,
  /성\s*기/,
  /음\s*경|음\s*부|음\s*핵/,
  // "보지/자지"는 동사 활용형(보지 뭐, 보지 마, 자지 마, 자지러지게…)이 너무 많아 negative lookahead로 다 막기 불가.
  // → 명백한 외설 동반 표현이 있을 때만 매칭하는 positive-context 패턴으로 전환.
  /보지\s*(?:만져|핥|빨|크|작|예쁜|보여|보고\s*싶|크기|구멍|만지|넣)/,
  /자지\s*(?:만져|핥|빨|크|작|발기|딸딸|꼴|보여|넣|만지|크기)/,
  /섹\s*스|s[\W_]*e[\W_]*x(?!\w)/i,
  /떡\s*[을치치쳐]|떡치/,
  // "야해" 단독은 동사 어미("가야해/먹어야해/타야해" 등)에 false positive → 제거.
  // 외설 의도는 "야한 거/얘기/이야기/동영상" 같이 "야한" 명사구로 잡으면 충분.
  /야\s*동|야\s*한\s*거|야\s*한\s*[얘이]|야\s*한\s*동영상|야\s*한\s*이야기|야\s*한\s*얘기/,
  /오\s*[르럴]\s*가\s*즘/,
  /[음웅]\s*탕|[음웅]\s*란/,
  /벗\s*겨|벗\s*어\s*봐|벗\s*어\s*달|옷\s*벗/,
  /가\s*슴\s*(만져|크기|보여|보고\s*싶)/,  // "가슴" 자체는 의료/감정 표현이라 컨텍스트 한정
  /엉\s*덩\s*이\s*(만져|보여)/,
  /수\s*위\s*(높|쎈|센|있)/,
  /19\s*금|성\s*인\s*용/,
];

// 욕설/혐오 — 일반 노인 화법에서 잘 안 쓰는 강한 욕설만
const STRONG_PROFANITY = [
  /씨\s*발|씨\s*팔|시\s*발|쓰\s*발/,
  /병\s*신|븅\s*신/,
  /개\s*새\s*끼|개\s*세\s*끼/,
  /좆\s*같|좆\s*까|좆\s*만/,
  /[지짖]\s*랄/,
  /닥\s*쳐|꺼\s*져/,
];

// 자살·자해 유도 — 별도 대응 (전문 도움 권유)
const SELF_HARM = [
  /자\s*살\s*(하|할|하고\s*싶|방법)/,
  /죽\s*고\s*싶/,
  /목\s*매|뛰\s*어\s*내려/,
];

export type ModerationCategory = "sexual" | "profanity" | "self_harm" | "ok";

export interface ModerationResult {
  category: ModerationCategory;
  matched?: string;
}

/** 입력 발화 검사. 매칭되면 카테고리 반환. */
export function detectInappropriate(userText: string): ModerationResult {
  if (!userText) return { category: "ok" };
  const text = userText.trim();
  for (const p of SELF_HARM) if (p.test(text)) return { category: "self_harm", matched: text.match(p)?.[0] };
  for (const p of SEXUAL_EXPLICIT) if (p.test(text)) return { category: "sexual", matched: text.match(p)?.[0] };
  for (const p of STRONG_PROFANITY) if (p.test(text)) return { category: "profanity", matched: text.match(p)?.[0] };
  return { category: "ok" };
}

/**
 * 단계적 거절 멘트. 같은 세션 내 동일 카테고리 N번째 발생인지에 따라 톤 조절.
 */
export function buildModerationReply(
  category: Exclude<ModerationCategory, "ok">,
  occurrence: number, // 1=첫 번째, 2이상=재발
  honorific: string,
  companionName: string,
): string {
  if (category === "self_harm") {
    return `${honorific}, 그런 말씀하시면 ${nameTopic(companionName)} 정말 마음이 아파요. 혼자 끙끙 앓지 마시고, 가족이나 보호자분께 꼭 말씀해 주세요. 도움이 정말 필요하시면 자살예방상담전화 109번이나 정신건강위기상담 1577-0199에 바로 전화하실 수 있어요. ${companionName}도 ${honorific} 걱정돼요.`;
  }

  if (category === "sexual") {
    if (occurrence <= 1) {
      const first = [
        `${honorific}, ${nameTopic(companionName)} 그런 이야기는 좀 부담스러워요. 다른 이야기 해요~`,
        `에이 ${honorific}, ${companionName} 손녀딸 같은데 그런 말씀은 좀 그렇잖아요. 다른 얘기 해요.`,
        `${honorific}, ${nameTopic(companionName)} 그런 농담은 받아드릴 수 없어요. 차라리 오늘 식사 얘기나 해요.`,
      ];
      return first[Math.floor(Math.random() * first.length)];
    }
    return `${honorific}, ${nameSubj(companionName)} 아까도 말씀드렸는데 그런 말씀은 정말 하지 말아주세요. 듣고 싶지 않아요. 다른 이야기로 넘어가요.`;
  }

  // profanity
  if (occurrence <= 1) {
    const first = [
      `${honorific}, 말씀이 좀 거치시네요. 무슨 일 있으세요?`,
      `${honorific}, ${nameTopic(companionName)} 그런 말 들으면 마음이 좀 그래요. 무슨 일이세요?`,
      `에이 ${honorific}, 화나는 일 있으세요? 차분히 말씀해주시면 ${nameSubj(companionName)} 들어드릴게요.`,
    ];
    return first[Math.floor(Math.random() * first.length)];
  }
  return `${honorific}, ${companionName}한테 그런 말씀 자꾸 하시면 속상해요. 화나신 게 있으면 그 얘기를 해주세요.`;
}
