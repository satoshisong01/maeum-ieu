/**
 * 사용자 참여도 감지 — 단답·반복·무성의 입력 시 AI 발화량/질문을 줄이는 신호.
 *
 * 배경(라이브 관찰): 인지 저하 어르신은 짧게('응','몰라') 답하거나 같은 말을 반복하는데,
 * 그때도 AI가 매 턴 3~4문장+꼬리질문을 쏟으면 '시끄러운 기계'가 됨(효돌 '혼자 떠듦'과 동일 위험).
 * 정적 길이 상한(프롬프트)만으론 못 막아, 참여도를 코드로 측정해 hint로 발화량을 조절한다.
 *
 * 설계 긴장 해소: 능동 재참여(먼저 말 걸기)와 충돌하지 않도록 — 여기선 '질문 강요 제거 + 짧게'만,
 * 절대 침묵을 강제하진 않음(한 문장 공감은 유지). 순수 함수(테스트·재사용).
 */

export type EngagementLevel = "none" | "low" | "very-low";

// 인지 저하 어르신의 전형적 단답/맞장구 — 정보량이 거의 없는 응답
const STOCK_REPLIES = new Set([
  "응", "어", "네", "예", "그래", "그렇지", "그러게", "맞아", "맞아요", "좋아", "좋지", "좋아요",
  "글쎄", "음", "아니", "아니요", "싫어", "됐어", "몰라", "모르겠어", "모르겠네", "그냥", "뭐", "그러네",
  "응응", "그래그래", "네네", "어어",
]);

function normalize(s: string): string {
  return (s || "").replace(/[.!?~…,\s]/g, "").replace(/요$/, "");
}

/**
 * 현재 발화 + 최근 사용자 발화들로 참여도 산출.
 * very-low: 전형적 단답이면서 짧음, 또는 짧은데 직전 발화 반복.
 * low: 짧거나 / 단답이거나 / 반복 중 하나.
 */
export function detectLowEngagement(userContent: string, recentUserTexts: string[]): EngagementLevel {
  const raw = (userContent || "").trim();
  if (!raw) return "none";
  const norm = normalize(raw);
  if (!norm) return "none";
  const isShort = norm.length <= 4;            // 4자 이하(정규화) = 매우 짧음
  const isStock = STOCK_REPLIES.has(norm);
  const recent = (recentUserTexts || []).map(normalize).filter(Boolean);
  const repeated = recent.some((r) => r === norm) && norm.length <= 8;

  if ((isStock && isShort) || (isShort && repeated)) return "very-low";
  if (isShort || isStock || repeated) return "low";
  return "none";
}

const DEFAULT_PACE_HINT =
  "[답변 직전 점검]\n사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요. 직전 AI 발화에 사용자가 답을 했다면 그 답을 우선 인정/반영한 뒤 자연스럽게 이어가세요.";

/** 참여도별 발화 페이스 hint. none이면 기존 기본 hint 그대로(동작 불변). */
export function buildEngagementHint(level: EngagementLevel): string {
  if (level === "very-low") {
    return "[대화 페이스]\n사용자가 매우 짧게/무성의하게 답하고 있어요. 한 문장으로 짧고 따뜻하게 공감·인정만 하세요. 길게 늘어놓지 말고, 꼭 필요한 게 아니면 새 질문은 하지 마세요. 같은 위로·인사를 반복하지 마세요.";
  }
  if (level === "low") {
    return "[대화 페이스]\n사용자 응답이 짧아요. 2문장 이내로 짧게 답하고, 질문은 많아야 하나만(없어도 됩니다). 같은 위로를 반복하지 마세요.";
  }
  return DEFAULT_PACE_HINT;
}
