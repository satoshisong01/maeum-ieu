/**
 * STT(음성→텍스트) 결과의 신뢰도 평가.
 *
 * 배경: Gemini STT는 confidence score를 노출하지 않으므로 휴리스틱으로 판정.
 * 노인 발화 특성(작은 목소리·틀니 마찰음·사투리·중얼거림)에서 흔한 오인식을
 * 감지해 "다시 말씀해주실래요?" 재질문으로 우회한다.
 *
 * 목적: 인지 분석기에 잘못 인식된 텍스트가 들어가 false positive를 만드는 것 차단.
 *
 * 정책:
 * - 응급 발화 감지는 STT 신뢰도와 무관하게 먼저 실행 (안전 우선).
 * - 신뢰도 통과 시에만 일반 대화/인지 분석으로 진행.
 */

export interface SttConfidenceResult {
  pass: boolean;
  confidence: number;  // 0~1 (대략적 수치)
  reason: string;      // 실패 사유 (디버깅/로그용)
}

/**
 * 단일 STT 결과 평가. audioDurationMs를 알면 발화 길이 대비 텍스트 길이 비교 가능.
 */
export function evaluateSttConfidence(
  transcription: string,
  audioDurationMs?: number,
): SttConfidenceResult {
  const text = (transcription || "").trim();

  // 1) 완전히 빈 결과
  if (text.length === 0) {
    return { pass: false, confidence: 0.0, reason: "empty transcription" };
  }

  // 2) 1글자인데 한글 음절이 아니면 잡음 (예: "ㅇ", ".", "?")
  //    "응"/"네"/"예"/"오" 등 한글 1글자 긍정·부정 답변은 통과 허용.
  if (text.length === 1 && !/[가-힣]/.test(text)) {
    return { pass: false, confidence: 0.1, reason: "single non-Korean char" };
  }

  // 3) STT 모델이 명시적으로 실패를 표기한 경우
  if (/^[(（]?\s*(?:음성을\s*인식하지\s*못|들리지\s*않|noise|silence|unknown|inaudible)/i.test(text)) {
    return { pass: false, confidence: 0.0, reason: "STT explicit failure marker" };
  }

  // 4) 알파벳·한글이 전혀 없으면 잡음 (예: "1234567890", "...")
  const korean = (text.match(/[가-힣]/g) || []).length;
  const letters = (text.match(/[a-zA-Z가-힣]/g) || []).length;
  if (letters === 0) {
    return { pass: false, confidence: 0.1, reason: "no letters (digits/symbols only)" };
  }

  // 5) 한글 비율 — Korean 입력을 기대하는데 라틴 문자가 압도적이면 오인식
  //    영문 주소·이름이 섞이는 경우는 letters 적어 통과시킴 (4글자 이상 시에만 비율 체크)
  if (letters >= 4 && korean / letters < 0.3) {
    return { pass: false, confidence: 0.25, reason: "low korean ratio" };
  }

  // 4) 동일 문자 연속(5회 이상) — STT 노이즈에서 자주 발생 (예: "아아아아아아")
  //    텍스트가 짧을 때(<10자)만 실패로 본다. 긴 문장 안에 "ㅋㅋㅋㅋㅋ" 정도는 정상.
  const repeated = text.match(/(.)\1{4,}/);
  if (repeated && text.length < 10) {
    return { pass: false, confidence: 0.2, reason: `repeated burst: ${repeated[0]}` };
  }

  // 5) Filler/머뭇거림만 있는 발화 — "음...", "어어...", "그..." 등
  if (/^[음어그아에오]{1,3}[\s.…]*$/.test(text)) {
    return { pass: false, confidence: 0.2, reason: "filler-only utterance" };
  }

  // 6) 자음/모음 단독(특수 한글 분리 입력) 비율 — 정상 한글이 거의 없으면 실패
  //    예: "ㅁㅁㅁ", "ㅏㅏ"
  const jamo = (text.match(/[ㄱ-ㅎㅏ-ㅣ]/g) || []).length;
  if (jamo >= 3 && korean === 0) {
    return { pass: false, confidence: 0.15, reason: "jamo-only" };
  }

  // 7) 길이 vs 음성 길이 (선택) — 3초 이상 발화인데 2글자 미만이면 의심
  if (audioDurationMs && audioDurationMs >= 3000 && text.length < 3) {
    return { pass: false, confidence: 0.2, reason: "long audio, short transcription" };
  }

  // 8) 특수문자/물음표 일색 — STT가 침묵/잡음을 punctuation으로 토해낸 경우
  if (/^[\s\p{P}\?\.]+$/u.test(text)) {
    return { pass: false, confidence: 0.0, reason: "punctuation-only" };
  }

  // 9) 동일 어절 반복 루프 — LLM 전사가 침묵/잡음에서 같은 단어를 수십 번 반복하는
  //    자기회귀 환각 (실사례 2026-07-10: "지금" ×47회가 정상 메시지로 저장됨).
  //    실제 발화의 강조 반복("아파 아파 아파", "빨리 빨리 빨리 빨리 와")은 3~4회 수준이라
  //    임계값을 넉넉히 잡아도 환각(수십 회)과 겹치지 않는다.
  //    토큰은 문장부호 제거 후 비교 — "지금, 지금. 지금" 같은 구두점 변주도 동일 어절로 취급.
  //    ⚠ 조난 어휘의 반복("아파 아파 아파 아파 아파", "살려줘"×N)은 진짜 외침일 수 있어 면제 —
  //      환각이 잘못 통과해도 대화 LLM·응급 백스톱이 받지만, 진짜 외침이 재질문에 막히면 응급 대응이 늦는다(2026-07-10 리뷰 #3).
  const tokens = text.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const DISTRESS = /아파|아프|아야|살려|도와|숨|가슴|어지러|아이고/;
  if (tokens.length >= 5 && !tokens.some((t) => DISTRESS.test(t))) {
    let maxRun = 1;
    let run = 1;
    for (let i = 1; i < tokens.length; i++) {
      run = tokens[i] === tokens[i - 1] ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    const unique = new Set(tokens).size;
    // 같은 어절 연속 6회 이상 — 자연 발화에선 사실상 없음
    if (maxRun >= 6) {
      return { pass: false, confidence: 0.1, reason: `word repetition loop (run=${maxRun})` };
    }
    // 발화 전체가 한 단어의 반복 (5회 이상) — 정보량이 단어 1개뿐이라 재질문이 낫다
    if (unique === 1) {
      return { pass: false, confidence: 0.1, reason: `single-word loop (×${tokens.length})` };
    }
    // 어휘 붕괴 — 8어절 이상인데 고유 어절 2종 이하 ("네 지금 네 지금 네 지금 네 지금")
    if (tokens.length >= 8 && unique <= 2) {
      return { pass: false, confidence: 0.1, reason: `vocabulary collapse (unique=${unique}/${tokens.length})` };
    }
  }

  return { pass: true, confidence: 1.0, reason: "" };
}

/**
 * 재질문 멘트 — STT 신뢰도 통과 못 했을 때 LLM 우회로 즉시 반환.
 * 자연스러운 손녀/손주 톤으로, 노인이 부담 없이 다시 말하도록.
 */
import { nameSubj } from "./korean-particle";

export function buildClarificationReply(
  honorific: string,
  companionName: string,
  attempt: number = 1,
): string {
  const variants = [
    `${honorific}, ${nameSubj(companionName)} 잘 못 들었어요. 한 번만 더 천천히 말씀해주실래요?`,
    `어? ${companionName} 귀가 잠깐 안 들렸나 봐요. ${honorific}, 한 번만 더 얘기해주실 수 있으세요?`,
    `${honorific}, 죄송한데 ${nameSubj(companionName)} 잘 못 알아들었어요. 한 번만 더 또렷하게 부탁드릴게요!`,
  ];
  return variants[Math.min(Math.max(attempt - 1, 0), variants.length - 1)];
}
