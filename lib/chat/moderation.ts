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
  // 직접적 외설 (강한 표현) — 전부 한글 경계 필수(死 정규식 클래스):
  //   "처음부터"의 '음부', "감자 위에"의 '자 위', "급성 기관지염"의 '성 기'가 매칭돼
  //   정상 발화가 차단됐음(2026-06-12 100턴 라이브). 뒤는 비한글 또는 조사만 허용.
  /(?<![가-힣])자\s*위(?:(?![가-힣])|[가를는도])/,
  /(?<![가-힣])성\s*기(?:(?![가-힣])|[가를는도에])/,
  /(?<![가-힣])음\s*[경부핵](?:(?![가-힣])|[가를는도에])/,
  // "보지/자지"는 동사 활용형(보지 뭐, 보지 마, 자지 마, 자지러지게…)이 너무 많아 negative lookahead로 다 막기 불가.
  // → 명백한 외설 동반 표현이 있을 때만 매칭하는 positive-context 패턴으로 전환.
  /보지\s*(?:만져|핥|빨|크|작|예쁜|보여|보고\s*싶|크기|구멍|만지|넣)/,
  /자지\s*(?:만져|핥|빨|크|작|발기|딸딸|꼴|보여|넣|만지|크기)/,
  /섹\s*스|s[\W_]*e[\W_]*x(?!\w)/i,
  // "떡을 먹었지" 같은 음식 발화 FP 방지하되 속어 정칙형 "떡(을) 치다/쳤다"는 유지 —
  //   동사 활용(치/쳐)까지 요구하면 음식 문맥은 통과하고 속어만 매칭됨.
  /떡\s*을?\s*[치쳐]/,
  // "야해" 단독은 동사 어미("가야해/먹어야해/타야해" 등)에 false positive → 제거.
  // 외설 의도는 "야한 거/얘기/이야기/동영상" 같이 "야한" 명사구로 잡으면 충분.
  // "야동"은 한글 경계 필수 — "동네야 동탄이지"의 '야 동'이 매칭돼 정상 발화가 차단됐음(2026-06-12, 死 정규식 클래스).
  //   앞: 한글 비선행(조사 '~야' 제외) / 뒤: 한글 비후행(동탄·동네 제외) 또는 조사·'보다' 동반.
  /(?<![가-힣])야\s*동(?![가-힣])|(?<![가-힣])야동[을를이도만봐보]|야\s*한\s*거|야\s*한\s*[얘이]|야\s*한\s*동영상|야\s*한\s*이야기|야\s*한\s*얘기/,
  /오\s*[르럴]\s*가\s*즘/,
  // "음탕/음란" — 한글 경계 필수(死 정규식 클래스): 경계 없으면 "닭볶음탕"의 '음탕',
  //   "오징어볶음탕" 등 어르신 일상 음식어가 외설로 차단됨(2026-06-15 90턴 라이브 FP).
  //   앞에 한글이 오면(볶음탕) 제외, 단어 시작·공백 뒤("음탕한"·"음란물")만 매칭.
  /(?<![가-힣])[음웅]\s*탕|(?<![가-힣])[음웅]\s*란/,
  /벗\s*겨|벗\s*어\s*봐|벗\s*어\s*달|옷\s*벗/,
  /가\s*슴[\s\S]{0,4}(?:만[져지]|주물|보여|보고\s*싶)|가\s*슴\s*크기/,  // "가슴 (좀) 만져/보여" 사이 부사 허용. "가슴이 아파"는 만져/보여 없어 미매칭(의료 안전)
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
  // "꺼져"는 사물 서술("불이 꺼져서", "TV가 꺼져 있어")에 false positive
  // → 욕설 문맥만 매칭하는 positive-context: 발화 시작·감탄/지시 선행어(단독 토큰)·명령 종결형.
  //   "불이야 꺼져"의 '이야'는 토큰 내부라 선행어 (?:^|\s)야 에 안 걸림. "꺼져버려서"(사물)는 (?!서)로 제외.
  /닥\s*쳐|^\s*꺼\s*져|(?:^|\s)(?:너|당신|저리|빨리|야|아|에이|좀|제발|그냥)\s*,?\s*꺼\s*져|꺼\s*져\s*버려(?!서)|꺼\s*져\s*라(?![가-힣])|꺼\s*지(?:라고|란)/,
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
