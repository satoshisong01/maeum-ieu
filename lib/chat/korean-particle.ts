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
  // 1) 회상 컨텍스트 검출
  const recallContext = /(?:외워[ㄴ던드]|외운|말씀\s*드린|아까\s*(?:드린|말씀)|기억(?:나|해))/.test(text);
  if (!recallContext) return text;

  // 2) 작은/큰따옴표로 묶인 한글 단어 2개+ 시퀀스 매칭 → 제거
  //    예: '나무', '자동차', '모자' / "나무" "자동차" "모자"
  const quotedSeq = /[''""]?[가-힣]{1,5}[''""]?\s*[,·、]\s*[''""]?[가-힣]{1,5}[''""]?(?:\s*[,·、]\s*[''""]?[가-힣]{1,5}[''""]?){0,4}(?:\s*(?:였는데|이었는데|이었어요|예요|이에요))?/g;
  let out = text;
  // 회상 컨텍스트가 있는 문장만 매칭 (다른 정상 나열 보호)
  out = out.replace(quotedSeq, (match) => {
    // 매칭에 따옴표가 적어도 한 번 등장하면 회상 단서로 간주
    if (/['"'""]/.test(match)) return "";
    return match;
  });
  return out.replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").trim();
}
