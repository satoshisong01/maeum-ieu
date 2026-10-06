/**
 * 기억력 놀이(3·5단어 등록) 감지 — **단일 출처**.
 *
 * 결함(2026-10-06 직접 운전): 사용자 모드 질문 풀의 등록 문항은 일부러 우회 표현이다
 *   ("제가 부르면 어르신이 받아주세요. 백로, 옹기, 부삽." · "제가 셋 던지면 바로 받기" · "메아리 놀이").
 *   그런데 회상 힌트(buildRecallVerificationHint)는 "외워 드릴게요/단어 세 가지 말씀"만 등록으로 봤다.
 *   그래서 어르신이 "아까 그 세 단어 뭐였더라?"라고 묻자 힌트가 **"이번 대화에서 단어를 외워드린 적이
 *   한 번도 없습니다"**라고 동반자에게 알렸고, 동반자는 "혹시 어디서 다른 단어를 들으셨을까요?"라고
 *   되물었다 — 기억이 걱정되는 어르신에게 방금 들은 것을 부정하는 말이다. 분석기도 같은 대화의 등록을
 *   못 봐서 그 턴의 회상 실패를 채점하지 않았다.
 *   → 형식(짧은 낱말 3개 또는 5개를 쉼표로 나열)과 놀이 단서를 같이 본다. 질문 풀 전수로 검증한다
 *     (__tests__/recall-registration.test.ts).
 */

/** 짧은 한글 낱말 3개(또는 5개) 쉼표 나열 */
const WORD_LIST = /(?<![가-힣])([가-힣]{1,5})\s*,\s*([가-힣]{1,5})\s*,\s*([가-힣]{1,5})(?:\s*,\s*([가-힣]{1,5})\s*,\s*([가-힣]{1,5}))?(?![가-힣])/;

/** 같은 발화에 있어야 하는 놀이·기억 단서 — 단순 나열("사과, 배, 감 좋아하세요?")과 구별 */
const GAME_CUE = /외워|외울|외우|기억|부를|부르면|부르는|불러|따라|받아|받기|되받|셋|세\s*(?:개|가지|마디|단어)|다섯|챙기|챙겨|새겨|담아|던지|던질|외치|메아리|입으로|불러\s*드|말씀\s*드릴/;

/** 숫자 낱말 — "사, 칠, 이"는 숫자 거꾸로 따라하기(주의력)이지 단어 등록이 아니다 */
const DIGIT_WORD = /^(?:일|이|삼|사|오|육|칠|팔|구|공|영|십)$/;

/** 이 AI 발화가 단어 등록이면 그 단어들, 아니면 null */
export function extractRegisteredWords(aiText: string): string[] | null {
  if (!aiText || !GAME_CUE.test(aiText)) return null;
  const m = aiText.match(WORD_LIST);
  if (!m) return null;
  const words = m.slice(1).filter((w): w is string => !!w);
  return words.every((w) => DIGIT_WORD.test(w)) ? null : words;
}

/** historyText(buildHistoryText 결과)의 AI 발화 중 **가장 최근** 등록 단어. 없으면 null */
export function findRegisteredWordsInHistory(historyText: string): string[] | null {
  if (!historyText) return null;
  const lines = historyText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:\[[^\]]+\]\s*)?AI:\s*(.+)$/);
    if (!m) continue;
    const words = extractRegisteredWords(m[1]);
    if (words) return words;
  }
  return null;
}
