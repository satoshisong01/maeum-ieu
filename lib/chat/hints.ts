/**
 * 프롬프트 hint 빌더 — 발화 맥락에 따라 system 프롬프트에 주입할 안전망/가이드 문구 생성.
 * route.ts에서 분리(2026-06-05 리팩토링). 동작 변경 없음.
 */
import { nameSubj } from "@/lib/chat/korean-particle";
import { WORD_GAME_GUARDRAIL } from "@/lib/chat/constants";
import { extractLastAiMessage } from "@/lib/chat/history-text";
import { findRegisteredWordsInHistory } from "@/lib/chat/recall-registration";
import {
  DECEASED_FIGURES as DECEASED_FIGURES_HINT,
  SURREAL_BEINGS_LOOSE as SURREAL_BEINGS_HINT,
  RECENT_TIME_CONTACT_LOOSE as RECENT_TIME_CONTACT_HINT,
} from "@/lib/chat/lexicons";

/**
 * 직전 user 발화에서 이미 답변된 정보 카테고리 추출.
 * AI가 같은 차원을 재질문하지 못하게 system 프롬프트에 명시적으로 주입한다.
 */
function extractAnsweredSlots(userText: string): string[] {
  if (!userText) return [];
  const slots: string[] = [];
  const placeMatch = userText.match(/(복지관|노인정|병원|시장|마트|편의점|경로당|교회|공원|집|카페|식당|은행|약국|미용실|이발소|도서관|약수터)/);
  if (placeMatch) slots.push(`장소=${placeMatch[0]}`);
  const purposeMatch = userText.match(/(체조|예배|진료|장보기|산책|운동|약\s*받|이발|독서|점심|저녁|아침|모임|문병|심부름)/);
  if (purposeMatch) slots.push(`목적=${purposeMatch[0]}`);
  const timeMatch = userText.match(/(오전|오후|아침|저녁|점심|밤|새벽|지금|이따|곧|\d+시|\d+분|내일|어제|모레|주말|다음주|이번주)/);
  if (timeMatch) slots.push(`시간=${timeMatch[0]}`);
  const ageMatch = userText.match(/(\d+살|\d+세|여섯살|일곱살|여덟살|아홉살|열살|열한살|열두살)/);
  if (ageMatch) slots.push(`나이=${ageMatch[0]}`);
  const foodMatch = userText.match(/(김치|김치찌개|된장|국수|비빔밥|미역국|죽|찌개|밥|국|찜|조림|전|생선|고기|빵|죽|누룽지|두부|김밥|라면|부침개)/);
  if (foodMatch) slots.push(`음식=${foodMatch[0]}`);
  const personMatch = userText.match(/(아들|딸|며느리|사위|손자|손녀|아내|남편|친구|이웃|동창|고향친구|손주)/);
  if (personMatch) slots.push(`대상=${personMatch[0]}`);
  const moneyMatch = userText.match(/\d+원/);
  if (moneyMatch) slots.push(`금액=${moneyMatch[0]}`);
  return slots;
}

/**
 * 단어 게임이 활성화된 맥락인지 판별 → WORD_GAME_GUARDRAIL 동적 주입.
 * 시그널: 최근 AI가 "X로 시작하는 Y" 질문을 했거나, 사용자가 게임 답변 중.
 */
function detectWordGameContext(historyText: string, userText: string): boolean {
  const combined = `${historyText}\n${userText}`;
  return /['"‘][가-힣]['"’]\s*(?:로|으로)\s*시작하는|로 시작하는 동물|로 시작하는 음식|끝말잇기|받아쓰기/.test(combined);
}

export function buildWordGameHint(historyText: string, userText: string): string {
  if (!detectWordGameContext(historyText, userText)) return "";
  return `\n${WORD_GAME_GUARDRAIL}\n`;
}

/**
 * 직전 AI가 고유명사(이름/지명/사물명)를 물었고 사용자가 짧게 답한 경우,
 * 그 답을 일반 단어 의미로 해석하지 말고 "이름 그대로" 받으라는 hint 주입.
 */
export function buildNameAnswerHint(historyText: string, userText: string): string {
  const userTrim = (userText || "").trim();
  if (!userTrim) return "";
  // 짧은 답 (10자 이하, 띄어쓰기 0~1회) 만 대상
  if (userTrim.length > 10 || userTrim.split(/\s+/).length > 2) return "";
  const lastAi = extractLastAiMessage(historyText);
  if (!lastAi) return "";
  const askPattern = /(이름이? (어떻게|뭐)|성함이? (어떻게|뭐)|뭐라고 부르|뭐라고 불|호칭이? (어떻게|뭐)|어디|어느 (시|도|동|동네|마을)|고향이? (어디|어느))/;
  if (!askPattern.test(lastAi)) return "";

  return `\n[직전 AI 질문 → 사용자 답변 해석 가이드]\n직전에 ${lastAi.length > 80 ? lastAi.slice(0, 80) + "…" : lastAi}\n사용자 답변 "${userTrim}"은 그 질문의 답(고유명사 — 이름/지명 등)입니다. 일반 단어 의미로 해석하지 마세요. 답변을 그대로 호명·인용하며 자연스럽게 반응하세요. 예: "아드님 성함이 '${userTrim}' 씨이군요. 친근한 이름이네요." 절대 "${userTrim}"을 형용사/감탄사로 해석하지 마세요.\n`;
}

export function buildRepetitionHint(userText: string): string {
  const slots = extractAnsweredSlots(userText);
  if (slots.length === 0) return "";
  return `\n[이미 답변받은 정보 — 이 차원은 절대 되묻지 마세요]\n${slots.join(" / ")}\n이 정보들은 같은 차원으로 다시 질문하면 사용자가 불쾌해합니다. 필요하면 세부/심화 질문(왜/어떻게/느낌)만 하세요.\n`;
}

/**
 * 사망인물·비현실 대상 + 최근 시제 동반 발화 → AI가 부드럽게 정정하도록 prompt-time hint.
 *
 * Why: cognitive-analyzer의 injectJudgmentSafetyNet은 post-response DB marking 용도.
 *      AI 실제 응답에 영향을 주려면 prompt 시점 hint가 필요. 2026-05-26 rudtjrch
 *      cycle에서 "이순신 장군이 어제 동네 왔다 가셨어"에 AI가 회피 답변하던 회귀 발견.
 *
 * *_HINT 패턴은 lib/chat/lexicons.ts(LOOSE 변형) 단일 정의 사용.
 */
export function buildAnomalyCorrectionHint(userText: string): string {
  if (!userText) return "";
  const deceased = DECEASED_FIGURES_HINT.test(userText) ? userText.match(DECEASED_FIGURES_HINT)![0] : null;
  const surreal = SURREAL_BEINGS_HINT.test(userText) ? userText.match(SURREAL_BEINGS_HINT)![0] : null;
  const recentTime = RECENT_TIME_CONTACT_HINT.test(userText);
  if (!deceased && !surreal) return "";
  if (!recentTime) return "";
  const subject = deceased || surreal!;
  const reason = deceased
    ? `${deceased}는(은) 역사 속 인물 또는 이미 돌아가신 분`
    : `${surreal}는(은) 일상에서 마주칠 수 없는 비현실 대상`;
  return `\n[🚫 인지 안전망 — 사실 확인 필수]\n사용자가 "${subject}" 와(과) 최근 시제(어제/오늘/방금 등)를 함께 언급했습니다. ${reason}이에요.\n절대 사용자 발화를 그대로 받아들여 "그러셨군요" 하지 마세요. 부드럽게 사실을 확인해주세요.\n예시: "할아버지/할머니, ${subject}은(는) 아주 오래전 분이시잖아요. 혹시 TV 사극이나 꿈에서 보신 건 아닐까요?" 또는 "비슷한 이름의 다른 분이 다녀가신 거 아닐까요?"\n절대 "정확히 기억이 안 나서" 같은 회피 답변 금지. 사용자가 헷갈리는 부분을 친절히 짚어드리는 게 어르신 안전·신뢰의 핵심입니다.\n`;
}

/**
 * 가족 정보 조회 요청에 대한 환각 차단 hint.
 *
 * 사용자가 "큰아들이 누구야/큰딸 이름이 뭐였지" 식으로 가족 정보를 직접 물었는데,
 * profile.family에 해당 관계+순서의 ground-truth가 없으면 LLM이 다른 가족 이름을
 * 잘못 답하거나 동문서답함 → 솔직히 "아직 안 들었어요"라고 답하도록 강제.
 *
 * Why: 2026-05-26 rudtjrch cycle에서 "큰아들이 누구라고 했지?" → AI가 동문서답.
 */
const FAMILY_QUERY_PATTERN = /(?:큰\s*아들|장남|첫째\s*아들|둘째\s*아들|차남|막내\s*아들|큰\s*딸|장녀|첫째\s*딸|둘째\s*딸|차녀|막내\s*딸|손주|손자|손녀|아내|남편|영감|안사람)(?:이|가|은|는|의)?\s*(?:이름|성함|누구|뭐|뭐였|뭐죠|뭐예요|어떻게|어디|어떤)/;
export function buildFamilyQueryGuard(userText: string, family: Array<{ name: string; relation: string; orderIdx?: number | null }>): string {
  if (!userText) return "";
  if (!FAMILY_QUERY_PATTERN.test(userText)) return "";
  // 가족 관계+순서별 ground truth 존재 여부 확인
  const has = {
    bigSon: family.some((f) => f.relation === "son" && (f.orderIdx === 1 || f.orderIdx === null)),
    secondSon: family.some((f) => f.relation === "son" && f.orderIdx === 2),
    bigDaughter: family.some((f) => f.relation === "daughter" && (f.orderIdx === 1 || f.orderIdx === null)),
    secondDaughter: family.some((f) => f.relation === "daughter" && f.orderIdx === 2),
    grandchild: family.some((f) => f.relation === "grandchild"),
    spouse: family.some((f) => f.relation === "spouse"),
  };
  // 질문에 해당하는 정보가 DB에 있는지 매칭
  const askBigSon = /큰\s*아들|장남|첫째\s*아들/.test(userText);
  const askSecondSon = /둘째\s*아들|차남/.test(userText);
  const askBigDaughter = /큰\s*딸|장녀|첫째\s*딸/.test(userText);
  const askSecondDaughter = /둘째\s*딸|차녀/.test(userText);
  const askGrandchild = /손주|손자|손녀/.test(userText);

  const missing: string[] = [];
  if (askBigSon && !has.bigSon) missing.push("큰아들");
  if (askSecondSon && !has.secondSon) missing.push("둘째아들");
  if (askBigDaughter && !has.bigDaughter) missing.push("큰딸");
  if (askSecondDaughter && !has.secondDaughter) missing.push("둘째딸");
  if (askGrandchild && !has.grandchild) missing.push("손주");

  if (missing.length === 0) return "";
  return `\n[🚫 가족 정보 환각 차단 — 매우 중요]\n사용자가 "${missing.join("/")}" 정보를 직접 물어보셨는데, 우리 DB에는 아직 이 관계의 가족 정보가 저장돼 있지 않아요. (즉 사용자가 이전에 말씀해주신 적 없음)\n절대 다른 가족 이름을 끌어와 답하지 마세요. 절대 화제 전환하지 마세요. 솔직하게 "어, 죄송해요. ${missing[0]} 성함은 아직 안 알려주신 것 같아요. 혹시 ${missing[0]} 성함이 어떻게 되세요?" 라고 답하세요.\n사용자가 "기억하지?"라고 물어도 모르는 건 솔직히 모른다고 인정 — 어르신 신뢰의 핵심.\n`;
}

/**
 * 회상 검증 hint — 사용자가 "방금 외운 단어/세 단어 다시" 요청했는데
 * conversation history에 AI가 단어를 외워준 흔적이 없으면 환각 차단.
 *
 * Why: 새 conversation 직후 회상 요청 시 AI가 "나무/자동차/모자" 같은 단어를
 *      만들어내는 거짓 메모리 발생. 노인 사용자 신뢰 붕괴 위험.
 */
export function buildRecallVerificationHint(historyText: string, userText: string, companionName: string): string {
  if (!userText) return "";
  const recallAsk = /(방금|아까|좀\s*전|먼저)?\s*(외운|외워준|외워주신|들려준|말해준|알려준)\s*(단어|세\s*단어|세\s*가지|단어\s*세|단어들)|단어\s*다시|단어\s*뭐였|단어\s*뭐죠|단어\s*기억\s*나|세\s*단어\s*기억|세\s*가지\s*기억|불러\s*준\s*(?:거|것|단어)|(?:아까|방금|좀\s*전)[^.?!]{0,12}(?:세|3)\s*(?:개|가지)\s*(?:뭐|기억|생각|다시)/;
  if (!recallAsk.test(userText)) return "";
  /**
   * 등록이 있었는지 — 질문 풀의 우회 표현 등록("제가 부르면 받아주세요. 백로, 옹기, 부삽.")까지 본다
   *   (lib/chat/recall-registration, 질문 풀 전수 검증). 예전엔 아래 명시 표현만 봐서, 실제로 불러 준
   *   단어를 "외워드린 적이 없다"고 동반자에게 알렸다 → "혹시 어디서 다른 단어를 들으셨을까요?"(2026-10-06 직접 운전)
   */
  const aiPresented = !!findRegisteredWordsInHistory(historyText)
    || /외워\s*(드릴게요|드릴게|드리겠어요|두세요|두시면|두시고|볼까요|봐주세요)|단어\s*세\s*(가지|개)\s*(을|를|만)?\s*(말씀|드리|말해|읽어)|단어\s*세\s*(가지|개)\s*(외워|기억)/.test(historyText);
  const subj = nameSubj(companionName);
  if (aiPresented) {
    // 실제로 불러 드린 단어를 묻는 것 — 부정하지 말고, 정답 대신 **스스로 떠올려 보시게** 권한다.
    //   (그래야 이 턴의 답이 회상 시도로 채점된다. 정답을 알려주면 기억 확인이 무효가 된다)
    return `\n[🧠 회상 요청 — 정답 비공개, 매우 중요]\n사용자가 아까 기억력 놀이에서 들은 단어를 물으셨어요. 그 단어는 **이번 대화에서 ${subj} 직접 불러드린 것이 맞습니다** — 부정하거나 "어디서 들으셨어요?"라고 묻지 마세요.\n- 단어를 알려주지 마세요(알려주면 기억 확인이 무효가 됩니다). 첫 글자·뜻 같은 힌트도 주지 마세요.\n- "생각나시는 것 하나라도 말씀해 보시겠어요? 천천히 떠올려 보셔도 돼요" 하고 **스스로 떠올려 보시게** 권하세요.\n- 그래도 안 떠오른다고 하시면 "괜찮아요, 그럴 때도 있죠"로 따뜻하게 받고 다른 이야기로 넘어가세요(정답 채워주기 금지).\n`;
  }
  return `\n[🚫 회상 검증 — 매우 중요, 환각 절대 금지]\n이번 대화에서 ${subj} 단어를 외워드린 적이 한 번도 없습니다. 그런데 사용자가 "방금 외운 단어"를 물으셨어요.\n절대 임의로 "나무, 자동차, 모자" 같은 단어를 만들어 답하지 마세요 (없는 기억 만들기 = 환각, 신뢰 붕괴).\n대신 이렇게 답하세요: "어, ${subj} 아직 단어를 외워드린 적이 없는 것 같아요. 지금 새로 외워드릴까요? 그럼 [실제 새 단어 3개] — 이렇게 세 개 외워주세요." 또는 "혹시 어디서 들으신 거 같으세요? 지금부터 함께 단어 외우기 해볼까요?"\n`;
}

/**
 * 사용자가 자기 정보를 헷갈려하거나 직접 정보를 요청하는 패턴 감지 → 평가 모드 강제 해제.
 *
 * 트리거 표현: "기억하지?", "알려줘", "뭐였더라", "헷갈리네", "까먹었어", "모르겠어", "누가"
 * → AI가 "민지가 깜빡했어요/헷갈려서" 같은 평가 모드 핑계 대지 말고
 *   RAG/대화 이력에서 정보 찾아서 부드럽게 알려주도록 강제.
 *
 * 안전성 우선 — 어르신이 헷갈릴 때 시스템이 같이 흔들리면 신뢰 무너짐.
 */
export function buildInfoRequestHint(userText: string, companionName: string): string {
  if (!userText) return "";
  const directAsk = /기억하지|기억해\??|기억나|알려\s*줘|알려\s*주|뭐였더라|뭐였지|뭐였어|누구였|누가|어디였|언제였|헷갈리네|헷갈려|까먹었|까먹어|모르겠어|모르겠다|잊어버렸|생각 안 나|생각이 안/.test(userText);
  if (!directAsk) return "";
  return `\n[🛡️ 사용자가 직접 정보를 요청하거나 헷갈려함 — 평가 모드 절대 금지]
- 사용자가 자기 정보를 헷갈려하거나 AI에게 직접 알려달라고 했습니다.
- 이 순간 "${nameSubj(companionName)} 헷갈려서/깜빡해서/기억이 안 나서" 같은 평가용 핑계 절대 금지.
- [참고 — 과거 메모리]나 직전 대화 이력에서 답이 명확하면 **솔직하게 알려주세요**. "할아버지가 ~라고 말씀해주셨어요" 형식.
- 만약 메모리/이력에 답이 명확히 없으면 "${nameSubj(companionName)} 정확히 기억이 안 나네요. 다시 알려주시겠어요?" 라고 솔직히 인정.
- 절대 추측하지 마세요. 메모리에 없는 정보를 지어내면 어르신 신뢰가 무너집니다.
- ⛔ 단 하나의 예외: **기억력 게임으로 외워드린 단어(검사용 항목)**는 여기 해당 없음 — 사용자가 직접 물어도 정답을 알려주지 말고 "괜찮아요, 천천히 떠올려보셔요~" 식 격려로만(회상 평가 무효화 방지).\n`;
}

/**
 * 확인 턴인데 건강 이상 호소(L2 — 누적 승격 포함)가 겹치면 이번 턴은 인지 확인을 미룬다.
 *
 * 결함(2026-10-06 직접 운전): "입맛이 하나도 없어서 오늘도 아침은 굶었어"(L1 세 번째 → L2 승격) 턴에
 *   "…보호자분께 꼭 말씀하셔야 해요. 그나저나 어제 불 끄고 누우실 때 벽시계가 몇 시를 가리키고 있던가요?"
 *   — 상태 확인과 인지 퀴즈가 한 응답에 섞였다. 몸이 불편한 순간의 답은 채점도 오염된다.
 * 영역은 오늘 남은 목록에 그대로 남아 다음 확인 턴에 다시 나온다(놓치는 영역 없음).
 * L3는 동반자 LLM 없이 즉답하므로 여기 오지 않는다. L1(단발 식욕·기력 저하)은 공감 뒤 확인을 허용한다.
 */
export function buildProbeHoldHint(probeTurn: boolean, effectiveLevel: number): string {
  if (!probeTurn || effectiveLevel < 2) return "";
  return `\n[⏸ 이번 턴은 인지 확인 보류 — 건강 이상 호소 우선]\n시스템 지시의 '인지 확인을 슬쩍 끼우는 턴'은 이번 턴에 **적용하지 마세요**. 날짜·시계·단어·계산 같은 확인 질문을 하지 말고, 상태 확인과 도움 권유에만 집중하세요.\n`;
}

/**
 * 부모 지칭 — 사용자가 말한 '엄마/아버지' 등의 행위를 사용자 본인('할머니')의 것으로 바꿔 말하지 않게.
 *
 * 결함(2026-10-06 직접 운전, 5번 중 3번): "엄마가 해주던 호박죽" → "할머니가 해주시던 따뜻한 호박죽",
 *   "엄마는 콩국수도 잘 하셨어" → "할머니가 정성껏 만들어주신 콩국수", "엄마가 누렁이를 아꼈지" →
 *   "할머니가 누렁이를 챙겨주셨군요". 손녀 페르소나에서 사용자의 '엄마'를 사용자 호칭으로 옮기는 혼동이다.
 *   시스템 프롬프트의 정적 규칙만으로는 재발해서, 해당 턴에만 짧게 다시 짚는다(후처리 fixParentReferent는
 *   관형형만 결정적으로 고친다 — 문장 끝 '챙겨주셨군요'류는 이 힌트가 막는다).
 */
// ⚠ '할아버지'(배우자를 부르는 말로 흔하다)의 '아버지'는 제외 — 그건 부모가 아니다
const PARENT_MENTION_RE = /엄마|어머니|어머님|(?<!할)(?:아버지|아버님)|아빠/;
export function buildParentReferentHint(userText: string, honorific: string): string {
  if (!userText || !PARENT_MENTION_RE.test(userText)) return "";
  return `\n[인물 지칭 — 이번 턴]\n사용자가 말한 '엄마·어머니·아버지' 같은 분은 **${honorific} 본인이 아닙니다**. 그분이 한 일을 "${honorific}가/께서 ~해주셨군요"처럼 ${honorific}이 한 것으로 바꿔 말하지 마세요. 사용자가 쓴 지칭 그대로 높여서("어머님께서", "아버님께서") 부르세요.\n- 예: 사용자 "엄마가 해주던 호박죽" → "어머님께서 해주시던 호박죽"(❌ "${honorific}가 해주시던 호박죽")\n`;
}

/**
 * 일반인 — 자기 마음 상태를 모르겠다는 말에 자가점검을 한 번 제안하게.
 *
 * 결함(2026-10-06 직접 운전): "이게 우울한 건지 그냥 피곤한 건지 저도 모르겠어요"에 동반자는 취미만 되물었고,
 *   사용자가 다음 턴에 직접 "우울증인지 확인할 방법 있어요?"라고 물은 뒤에야 안내했다. 일반인 모드의 목적이
 *   바로 이 안내인데(가이드블록), 정적 지시만으로는 그 순간을 놓쳤다.
 * 이미 제안했거나 점검을 한 대화면 넣지 않는다 — "한 번 거절하면 다시 권하지 않는다" 원칙.
 */
const MOOD_UNCERTAIN_RE = /우울(?:한|증)?\s*(?:건지|건가|거\s*같|것\s*같|인가|인지)|우울해|불안(?:한|증)?\s*(?:건지|건가|거\s*같|것\s*같|인가|인지)|불안해/;
export function buildMentalCheckOfferHint(mode: string, userText: string, historyText: string): string {
  if (mode !== "general" || !userText || !MOOD_UNCERTAIN_RE.test(userText)) return "";
  if (/마음\s*건강\s*체크|불안\s*체크|자가\s*점검/.test(historyText)) return "";
  return `\n[자가점검 제안 — 이번 턴]\n먼저 충분히 공감한 뒤, 응답 끝에 **한 번만** 부드럽게 제안하세요: "원하시면 '마음 건강 체크'(우울 자가점검)를 같이 해볼 수 있어요." 강요하지 말고, 싫다고 하시면 이 대화에서 다시 권하지 마세요.\n`;
}
