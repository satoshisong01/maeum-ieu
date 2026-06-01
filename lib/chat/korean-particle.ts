/**
 * 한국어 조사 helper — 받침 여부에 따라 자연스러운 조사 + 친근체 이름 형태 자동 처리.
 *
 * 규칙 (사용자 명시):
 *   - 받침 있는 이름 (수진/영민/진우): 친근체에서 "이"를 추가 → 수진이가, 수진이는
 *   - 받침 없는 이름 (수지/민지/영희): 그대로 → 수지가, 수지는
 *
 * 표준 한국어 조사:
 *   - 받침 있음: 은/이/을/과/와(과)/으로
 *   - 받침 없음: 는/가/를/와/로
 */

/** 마지막 글자에 받침이 있는지 (한글 음절 기준) */
export function hasJongseong(word: string): boolean {
  if (!word) return false;
  const lastChar = word[word.length - 1];
  const code = lastChar.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return false;
  return (code - 0xAC00) % 28 !== 0;
}

/**
 * 친근체 이름 — 받침 있으면 "이" 추가. "수진" → "수진이", "수지" → "수지".
 * 자녀·손주·동반자 등 친근한 호명에 사용.
 */
export function familiarName(name: string): string {
  if (!name) return name;
  return hasJongseong(name) ? `${name}이` : name;
}

/** {이름}이가 / {이름}가 — 친근체 주격 */
export function nameSubj(name: string): string {
  return `${familiarName(name)}${hasJongseong(name) ? "가" : "가"}`;
}

/** {이름}이는 / {이름}는 — 친근체 주제 */
export function nameTopic(name: string): string {
  return `${familiarName(name)}${hasJongseong(name) ? "는" : "는"}`;
}

/** {이름}이를 / {이름}를 — 친근체 목적 */
export function nameObj(name: string): string {
  return `${familiarName(name)}${hasJongseong(name) ? "를" : "를"}`;
}

/** {이름}이도 / {이름}도 */
export function nameAlso(name: string): string {
  return `${familiarName(name)}도`;
}

/** 일반 단어용 — 받침 따라 은/는 */
export function eunNeun(word: string): string {
  return `${word}${hasJongseong(word) ? "은" : "는"}`;
}

/** 일반 단어용 — 받침 따라 이/가 */
export function iGa(word: string): string {
  return `${word}${hasJongseong(word) ? "이" : "가"}`;
}

/** 일반 단어용 — 받침 따라 을/를 */
export function eulReul(word: string): string {
  return `${word}${hasJongseong(word) ? "을" : "를"}`;
}

/** 일반 단어용 — 받침 따라 과/와 */
export function gwaWa(word: string): string {
  return `${word}${hasJongseong(word) ? "과" : "와"}`;
}

/**
 * "이름이에요/예요" 정규화 — 받침 없는 이름에 "이에요" 붙으면 어색 ("수지이에요").
 * 받침 없으면 "예요", 받침 있으면 "이에요".
 * AI 응답 후처리에서 호명 어색함 정정.
 */
export function normalizeImnida(text: string, knownNames: string[] = []): string {
  if (!text) return text;
  return text.replace(/([가-힣]{2,4})(이에요|이예요)\b/g, (match, name: string) => {
    if (hasJongseong(name)) return `${name}이에요`;
    return `${name}예요`;
  });
}

/**
 * 회상 평가 정답 노출 차단 — AI가 "외워드린 단어 세 개 기억나세요? '나무', '자동차', '모자'" 같이
 * 정답을 함께 노출하는 회귀가 prompt 강화로도 자주 재발. 응답 후처리에서 단서 부분 자동 제거.
 *
 * 대상 패턴: 회상 요청 컨텍스트 + 작은따옴표/큰따옴표 묶인 한글 단어 2개+ 시퀀스
 *   예: "기억나세요? '나무', '자동차', '모자'였는데" → "기억나세요?"
 */
export function stripRecallAnswerLeak(text: string): string {
  if (!text) return text;
  // 0) 등록(외울 단어를 지금 제시하는) 발화면 단어를 보여줘야 하므로 strip 절대 금지.
  //    예: "세 가지 단어 말씀드릴게요. 나무, 자동차, 모자. 이따 여쭤볼게요" → 단어 유지.
  //    (이걸 안 막으면 "잘 기억해 주세요"의 '기억해'가 recallContext에 걸려 외울 단어가 지워짐 — ****이에요 버그)
  const isRegistration = /말씀드릴게요|말씀드릴\s*테니|불러드릴게요|불러\s*드릴|들려드릴게요|들려드릴\s*테니|외워\s*(?:보세요|주세요|볼래|두세요|보실래|드릴)|잘\s*기억(?:해|하)\s*(?:주세|두세)|이따(?:가)?\s*(?:다시\s*)?(?:한\s*번\s*)?여쭤|잠깐\s*(?:만\s*)?외워|세\s*(?:개|가지)\s*(?:를)?\s*(?:말씀\s*드|불러)/.test(text);
  if (isRegistration) return text;

  // 1) 회상 컨텍스트 검출 — "외운/외워드린/외워달라고/말씀드린/기억나세요" + 정답 노출 위험
  const recallContext = /(?:외워[ㄴ던드]|외운|외워달라|외워드|말씀\s*드린|아까\s*(?:드린|말씀)|기억(?:나|해))/.test(text);
  if (!recallContext) return text;

  let out = text;

  // 정답 나열 뒤에 붙는 계사·종결 어미 — 함께 소거해야 "단어 세 개는 입니다" 같은 잔여 방지.
  const COPULA_TAIL = "(?:\\s*(?:였는데|이었는데|이었어요|이었어|예요|이에요|입니다|이고|이며|이지|이라고|이란다|이래|이라니까|랍니다|이야|이었지))?";

  // 2) 따옴표 묶인 한글 단어 2개+ 시퀀스 매칭 → 제거 ('나무', '자동차', '모자')
  const quotedSeq = new RegExp(`[''""][가-힣]{1,5}[''""](?:\\s*[,·、]\\s*[''""]?[가-힣]{1,5}[''""]?){1,5}${COPULA_TAIL}`, "g");
  out = out.replace(quotedSeq, "");

  // 3) 따옴표 없는 한글 단어 3개 콤마 나열 + 회상 마커 동반 (보수적)
  //    예: "단어 세 개, 기억나세요? 나무, 자동차, 모자였는데" → 정답 부분 제거
  //    매우 보수적 — 회상 컨텍스트 문장 안에서만, "세 단어/세 개/단어 N개" 마커 동반 시
  const hasRecallMarker = /(?:세\s*개|세\s*가지|세\s*단어|단어\s*(?:세|3)\s*(?:개|가지))/.test(text);
  if (hasRecallMarker) {
    const bareSeq = new RegExp(`([가-힣]{1,5})\\s*,\\s*([가-힣]{1,5})\\s*,\\s*([가-힣]{1,5})${COPULA_TAIL}`, "g");
    out = out.replace(bareSeq, "");
  }

  // 4) 정답 제거로 생긴 끊긴 lead-in 정리 — "단어 세 개는 ." / "세 가지는 ." 처럼
  //    계사 목적어가 사라져 비문이 된 조각을 자연스러운 질문형으로 복원.
  //    "...세 개는 . 기억나세요?" → "...세 개, 기억나세요?"
  out = out
    .replace(/((?:단어\s*)?(?:세|3)\s*(?:개|가지|단어)|단어\s*(?:세|3)\s*(?:개|가지))\s*(?:는|은|이|가|를)?\s*[.!?]+\s*/g, "$1, ")
    // 끝에 매달린 계사 lead-in ("...세 개는" 으로 문장이 끝남) → 조사 제거
    .replace(/((?:세|3)\s*(?:개|가지|단어))\s*(?:는|은|이|가|를)\s*$/g, "$1")
    // 따옴표/계사 제거 후 남는 고립 종결("예요.", "이에요.") 앞 공백 정리
    .replace(/\s+([.!?])/g, "$1");

  return out.replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").replace(/,\s*([.!?])/g, "$1").trim();
}
