/**
 * 일일 대화량 제한 — 1인당 하루 턴 수 상한.
 *
 * 왜 필요한가(2026-10-01 실측): 턴당 LLM 비용이 약 $0.0069(10원)이고 전부 입력 토큰이
 *   매 턴 재전송되는 구조라, 무제한이면 1인 월 비용이 사용량에 선형으로 늘어난다.
 *   하루 30턴 ≈ 월 9,400원 / 하루 100턴 ≈ 월 31,000원. 가격 정책의 전제가 되는 장치다.
 *
 * 설계 원칙 — 어르신에게 오류를 보여주지 않는다:
 *   70~90대 사용자는 HTTP 오류나 "한도 초과" 같은 문구로 상황을 이해하거나 복구할 수 없다.
 *   한도에 닿으면 429가 아니라 **동반자가 말하는 따뜻한 마무리 인사**를 200으로 돌려준다.
 *   화면에는 평소와 같은 말풍선이 뜨고 TTS로 읽히므로 "오늘은 그만"이라고 자연히 이해된다.
 *
 * 카운트 기준:
 *   - KST 자정 기준 '오늘' 저장된 사용자 발화(role="user") 수. Message 테이블을 그대로 쓰므로
 *     별도 카운터 테이블이 없고, 서버 재시작·인스턴스 분산에 영향받지 않는다.
 *     (Message(conversationId, createdAt) 인덱스가 있어 조회가 인덱스 스캔으로 처리됨)
 *   - 검진(대리 검사) 턴과 pro·general 계정은 제한하지 않는다 — 비용 주체·목적이 다르다.
 */
import { prisma } from "@/lib/prisma";
import { EXCLUDE_OBSERVATION } from "@/lib/chat/observation";

/**
 * 기본 상한 — env DAILY_TURN_LIMIT로 조정. **명시적인 0 이하면** 제한 없음(운영 중 비상 해제용).
 *
 * ⚠ 빈 문자열을 "미설정"으로 다룬다(2026-10-02 수정). `Number("")`는 0이고 `isFinite(0)`은
 *   true라, 이전 구현은 **빈 값 env를 '제한 해제'로 해석**했다. ECS 태스크 정의·CI 변수에서
 *   값 없이 키만 선언하는 건 흔한 실수이고, 그러면 비용 보호 장치가 조용히 꺼진다
 *   (에러도 로그도 없다 — 청구서에서나 드러난다).
 *   의도적 해제는 "0"을 명시해야 하고, 그건 아래에서 그대로 통과한다.
 */
export const DAILY_TURN_LIMIT = (() => {
  const raw = process.env.DAILY_TURN_LIMIT?.trim();
  if (!raw) return 100;                         // 미설정 또는 빈 문자열 → 기본값
  const n = Number(raw);
  return Number.isFinite(n) ? n : 100;          // 숫자 아님 → 기본값
})();

/** 상한에 가까워졌음을 미리 알리는 지점 — 갑자기 끊기면 어르신이 당황한다. */
const WARN_AT_REMAINING = 5;

export interface DailyUsage {
  /** 오늘 사용한 사용자 발화 수 */
  used: number;
  limit: number;
  /** 한도를 모두 썼는가 — true면 대화를 진행하지 않고 마무리 인사를 돌려준다 */
  exceeded: boolean;
  /** 남은 턴이 적어 미리 알려야 하는가 */
  nearLimit: boolean;
  remaining: number;
}

/** KST 자정(= UTC 기준 그 시각)을 Date로 — 오늘 00:00 KST */
function kstMidnightUtc(now = new Date()): Date {
  const kstMs = now.getTime() + 9 * 3600 * 1000;
  const kst = new Date(kstMs);
  const midnightKstMs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
  return new Date(midnightKstMs - 9 * 3600 * 1000);
}

/**
 * 오늘 사용량 조회. 제한이 꺼져 있거나 조회 실패 시에는 **통과**시킨다 —
 * 과금 보호 장치가 대화를 막는 쪽으로 실패하면 어르신이 서비스를 쓸 수 없게 된다.
 *
 * @param userId 넘기면 구독 티어를 반영해 상한을 올린다(미전달 시 무료 상한).
 *   구독 조회는 무료 상한 근처에서만 수행한다 — 평상시 턴에 쿼리를 더하지 않기 위해.
 */
export async function getDailyUsage(conversationId: string, userId?: string): Promise<DailyUsage> {
  const freeLimit = DAILY_TURN_LIMIT;
  const none: DailyUsage = { used: 0, limit: freeLimit, exceeded: false, nearLimit: false, remaining: freeLimit };
  if (freeLimit <= 0) return none;

  try {
    // ⚠ 상시 감시 기록(혼잣말 조각)은 대화가 아니다 — 세면 감시를 켠 날 대화가 막힌다(2026-10-06).
    const used = await prisma.message.count({
      where: { conversationId, role: "user", createdAt: { gte: kstMidnightUtc() }, ...EXCLUDE_OBSERVATION },
    });

    // 구독 상한은 **무료 상한에 근접했을 때만** 조회한다 — 평상시 턴(대부분)에
    //   구독 조회를 더하지 않기 위해. 무료 여유가 남아 있으면 티어를 알 필요가 없다.
    let limit = freeLimit;
    if (userId && used >= freeLimit - WARN_AT_REMAINING) {
      // 동적 import — entitlement가 DAILY_TURN_LIMIT을 되참조하므로 top-level 순환을 피한다
      const { getEntitlement } = await import("@/lib/billing/entitlement");
      const ent = await getEntitlement(userId);
      if (ent.dailyTurnLimit <= 0) return { ...none, used }; // 유료 무제한
      limit = Math.max(limit, ent.dailyTurnLimit);
    }

    const remaining = Math.max(0, limit - used);
    return {
      used, limit, remaining,
      exceeded: used >= limit,
      nearLimit: remaining > 0 && remaining <= WARN_AT_REMAINING,
    };
  } catch (e) {
    console.warn("[daily-limit] 사용량 조회 실패 — 제한 미적용으로 통과:", e instanceof Error ? e.message : e);
    return none;
  }
}

/**
 * 한도 도달 시 어르신에게 들려줄 마무리 인사.
 * 금지·오류 어휘("제한", "초과", "불가")를 쓰지 않는다 — 제재가 아니라 하루를 닫는 인사다.
 */
export function buildDailyLimitReply(honorific: string, companionName: string): string {
  return `${honorific}, 오늘 ${companionName}랑 이야기 많이 나눴네요. 목도 쉬셔야 하니 오늘은 여기까지 하고, 내일 또 만나서 얘기해요. 편히 쉬세요.`;
}

/**
 * 한도 안내 문구를 **사용자 정보까지 조회해서** 완성한다.
 *
 * 왜 여기 있나: 호칭·동반자 이름 유도 로직이 라우트마다 복사되면, 한쪽만 바뀌는 순간
 *   같은 어르신이 경로에 따라 다른 이름으로 불린다 — Live는 **목소리**로 들리므로
 *   그 불일치가 글자보다 크게 체감된다(가이드 F3).
 *   `/api/live/token`(세션 발급)과 `/api/live/turn`(세션 중 도달)이 같은 문구를 써야 한다.
 *
 * DB 조회가 실패하면 기본 호칭으로 떨어진다 — 안내를 못 하는 것보다 낫다.
 */
export async function buildDailyLimitReplyForUser(userId: string): Promise<string> {
  const { prisma } = await import("@/lib/prisma");
  const { getHonorific } = await import("@/lib/chat/prompt");
  const { COMPANION_DEFAULTS } = await import("@/lib/chat/constants");
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, age: true, gender: true, userHonorific: true, companionName: true },
  }).catch(() => null);
  const derived = getHonorific(u?.age ?? null, u?.gender ?? null);
  const honorific = u?.userHonorific?.trim()
    || (derived === "선생님" && u?.name?.trim() ? `${u.name.trim()}님` : derived);
  return buildDailyLimitReply(honorific, u?.companionName?.trim() || COMPANION_DEFAULTS.name);
}

/**
 * 남은 턴이 적을 때 시스템 프롬프트에 덧붙일 지시 — 갑작스러운 종료를 예고한다.
 *
 * 완성된 응답에 문장을 바로 붙이면 TTS 문장 분할·후처리 파이프라인과 어긋나므로,
 * 모델이 자기 말투로 자연스럽게 녹이도록 지시로 전달한다.
 */
export function buildNearLimitPromptHint(remaining: number): string {
  return `\n\n[오늘 대화 마무리 예고 — 이번 턴에만 적용]
오늘 나눌 수 있는 이야기가 ${remaining}번 정도 남았습니다. 평소처럼 답한 뒤,
**마지막에 한 문장만** 덧붙여 곧 쉬러 갈 것을 부드럽게 알려주세요.
- "제한"·"한도"·"초과" 같은 말은 쓰지 마세요. 제재가 아니라 하루를 닫는 인사입니다.
- 예: "오늘은 조금 뒤에 쉬러 갈 거예요. 하실 말씀 있으면 지금 해주세요."
- 어르신이 무거운 이야기(사별·통증)를 하는 중이면 예고하지 말고 공감에만 집중하세요.`;
}
