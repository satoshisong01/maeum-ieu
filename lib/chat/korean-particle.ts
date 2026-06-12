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
  // 끝 경계는 한글 친화 lookahead 사용 — ASCII \b는 직전 글자 '요'(한글)가 \w가 아니라
  // 문장 끝·공백·구두점 뒤에서 매칭이 항상 실패했음(死). 다음 글자가 한글이 아닐 때만 정규화.
  return text.replace(/([가-힣]{2,4})(이에요|이예요)(?![가-힣])/g, (match, name: string) => {
    if (hasJongseong(name)) return `${name}이에요`;
    return `${name}예요`;
  });
}

/**
 * 동반자 이름 조사 오류 정정 — LLM이 받침 있는 이름에 받침 없는 조사를 붙이는 실수
 * ("지윤가 기억하고 있지요" / "지윤랑 이야기"). 받침 있는 이름만 친근체로 정정:
 *   지윤가→지윤이가, 지윤는→지윤이는, 지윤랑→지윤이랑, 지윤를→지윤이를, 지윤와→지윤이와, 지윤야→지윤아
 * "지윤이가"처럼 이미 올바른 형태는 '이'가 끼어 있어 패턴에 안 걸림.
 */
export function fixFamiliarNameParticles(text: string, name: string): string {
  if (!text || !name || !hasJongseong(name)) return text;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`(?<![가-힣])${esc}(가|는|를|랑|와)(?![가-힣])`, "g"), `${name}이$1`)
    .replace(new RegExp(`(?<![가-힣])${esc}야(?![가-힣])`, "g"), `${name}아`);
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
  // "따라 말씀해/따라 해 보세요"는 등록 단계의 재요청 — 단어를 보여줘야 함.
  //   (전문가 모드 100턴에서 "불러드린 단어 ''를 따라 말씀해주시겠어요" 빈 따옴표 버그 — 과거 보고형
  //    recallContext 보강(불러드렸)이 따라하기 재요청까지 회상으로 오인해 단어를 지웠음, 2026-06-12)
  const isRegistration = /말씀드릴게요|말씀드릴\s*테니|불러드릴게요|불러\s*드릴|들려드릴게요|들려드릴\s*테니|외워\s*(?:보세요|주세요|볼래|두세요|보실래|드릴)|잘\s*기억(?:해|하)\s*(?:주세|두세)|이따(?:가)?\s*(?:다시\s*)?(?:한\s*번\s*)?여쭤|잠깐\s*(?:만\s*)?외워|세\s*(?:개|가지)\s*(?:를)?\s*(?:말씀\s*드|불러)|따라\s*(?:해|말씀|말해|읽어)/.test(text);
  if (isRegistration) return text;

  let out = text;

  // 0.5) 회상 실패 시 빠진 정답을 채워주는 단일 단어 노출 제거 (단어/회상 맥락에서만).
  //    "마지막 하나는 '소나무'였어요" / "나머지는 모자예요" / "세 번째는 ○○이었죠" → 문장째 삭제.
  if (/외운|외워|외울|단어|회상|기억(?:나|해|력)/.test(text)) {
    out = out.replace(
      /(?:마지막\s*하나|마지막\s*단어|마지막\s*거|나머지|남은\s*하나|세\s*번째(?:\s*(?:하나|단어|거))?|세째)\s*(?:는|은)\s*[^.!?]*?['"‘’“”]?[가-힣]{1,6}['"‘’“”]?\s*(?:였|이었|이에|예|이라)(?:어요|었어요|에요|요|죠|었죠)[.!]?\s*/g,
      "",
    );
  }

  // 1) 회상 컨텍스트 검출 — "외운/외워드린/외워달라고/말씀드린/기억나세요" + 정답 노출 위험
  //    과거 보고형("말씀드렸었죠"/"불러드렸")과 "생각나" 누락으로 정답 3개가 그대로 노출되던 갭 보강 (2026-06-11)
  const recallContext = /(?:외워[ㄴ던드]|외운|외워달라|외워드|(?:말씀|불러|알려)\s*드(?:린|렸)|아까\s*(?:드린|말씀)|기억(?:나|해)|생각나)/.test(text);
  if (!recallContext) return out.replace(/\s{2,}/g, " ").replace(/\s+([.!?])/g, "$1").trim();

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
    // 카운터 마커("세 개"/"세 가지")가 콤마로 바로 이어지면 카운터는 보존하고 뒤 정답 3개만 제거.
    //   "단어 세 개, 나무, 자동차, 모자였는데" → "단어 세 개" (이전엔 '개,나무,자동차'를 잘못 잡아
    //    정답 '모자'가 누출되고 '세 개'가 '세 '로 깨졌음).
    const bareSeq = new RegExp(
      `((?:세|3)\\s*(?:개|가지|단어)\\s*,\\s*)?([가-힣]{1,5})\\s*,\\s*([가-힣]{1,5})\\s*,\\s*([가-힣]{1,5})${COPULA_TAIL}`,
      "g",
    );
    out = out.replace(bareSeq, (_full, counter?: string) => (counter ? counter.replace(/\s*,\s*$/, "") : ""));
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
