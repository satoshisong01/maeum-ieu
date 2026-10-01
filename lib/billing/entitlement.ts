/**
 * 구독 권리(entitlement) 판정 — "이 계정이 지금 유료 티어인가".
 *
 * 결제자 ≠ 혜택 대상: 보호자가 자기 Play 계정으로 결제하고 혜택은 연결된 어르신에게 간다.
 *   그래서 판정은 **결제자이거나 혜택 대상이면 통과**로 본다(한 구독이 두 계정을 덮는다).
 *   - 어르신: 대화 상한이 올라간다(beneficiary)
 *   - 보호자: 보호자 전용 기능이 열린다(purchaser)
 *
 * 실패 방향: 조회 실패나 미설정은 **무료 티어**로 떨어진다. 무료 티어는 현재 운영 조건과
 *   같으므로 과금 장치의 장애가 서비스 중단이 되지 않는다. 반대로 '실패 시 유료 취급'은
 *   비용이 통제되지 않으므로 쓰지 않는다.
 *
 * ⚠ 안전 경로와 무관: 응급 감지·보호자 위급 알림은 구독과 절대 연동하지 않는다.
 *   돈을 내지 않아 119 안내가 막히는 설계는 어떤 경우에도 허용하지 않는다.
 */
import { prisma } from "@/lib/prisma";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { ENTITLED_STATUSES, isProProduct, proDailyTurnLimit } from "@/lib/billing/plans";

export type Tier = "free" | "pro";

export interface Entitlement {
  tier: Tier;
  /** 일일 대화 상한(0 이하 = 제한 없음) */
  dailyTurnLimit: number;
  /** 보호자 전용 기능(상태 요약·추세) 열람 가능 — 위급 알림은 여기에 포함되지 않는다 */
  guardianFeatures: boolean;
  /** 혜택 만료 시각(null=없음/무기한) */
  expiresAt: Date | null;
  /** 어떤 경로로 얻은 권리인가 — 결제자 본인 / 보호자가 결제해 받은 혜택 */
  source: "none" | "purchaser" | "beneficiary";
}

const FREE: Entitlement = {
  tier: "free",
  dailyTurnLimit: DAILY_TURN_LIMIT,
  guardianFeatures: false,
  expiresAt: null,
  source: "none",
};

/** 무료 티어 권리 — 조회 없이 알 수 있는 기본값 */
export function freeEntitlement(): Entitlement {
  return { ...FREE, dailyTurnLimit: DAILY_TURN_LIMIT };
}

/**
 * 계정의 현재 권리. 결제자이거나 혜택 대상이면 유료 티어.
 * 만료 시각이 지난 구독은 상태가 아직 active여도 무료로 본다(RTDN 지연 대비).
 */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  if (!userId) return freeEntitlement();
  try {
    const now = new Date();
    const subs = await prisma.subscription.findMany({
      where: {
        OR: [{ beneficiaryUserId: userId }, { purchaserUserId: userId }],
        status: { in: [...ENTITLED_STATUSES] },
        revokedAt: null,
      },
      select: { productId: true, expiresAt: true, beneficiaryUserId: true, purchaserUserId: true },
      orderBy: { expiresAt: "desc" },
      take: 5,
    });

    // 만료 시각이 지난 것은 제외 — RTDN(갱신·해지 통지)이 늦게 와도 혜택이 새지 않게.
    //   expiresAt이 null인 구독은 만료 정보를 아직 받지 못한 상태이므로 유효로 본다
    //   (검증 직후 생성된 레코드. verify가 만료 시각을 채운다).
    const live = subs.filter((s) => (!s.expiresAt || s.expiresAt > now) && isProProduct(s.productId));
    if (live.length === 0) return freeEntitlement();

    const best = live[0];
    return {
      tier: "pro",
      dailyTurnLimit: proDailyTurnLimit(DAILY_TURN_LIMIT),
      guardianFeatures: true,
      expiresAt: best.expiresAt ?? null,
      source: best.purchaserUserId === userId ? "purchaser" : "beneficiary",
    };
  } catch (e) {
    console.warn("[entitlement] 조회 실패 — 무료 티어로 처리:", e instanceof Error ? e.message : e);
    return freeEntitlement();
  }
}

/**
 * 보호자가 결제할 때의 혜택 대상(= 연결된 어르신) 결정.
 *
 * 연결이 1명이면 그 사람, 여러 명이면 **가장 먼저 연결된 어르신**을 기본으로 한다
 *   (클라이언트가 보낸 대상을 그대로 믿지 않는다 — 남의 계정에 혜택을 붙일 수 있다).
 *   요청에 대상이 명시되면 active 링크인지 검증한 뒤에만 인정한다.
 * 연결된 어르신이 없으면 결제자 본인(어르신 계정이 직접 결제한 경우)이 대상이다.
 */
export async function resolveBeneficiary(purchaserUserId: string, requested?: string): Promise<string> {
  if (requested && requested !== purchaserUserId) {
    const link = await prisma.expertPatient.findUnique({
      where: { expertUserId_patientUserId: { expertUserId: purchaserUserId, patientUserId: requested } },
      select: { status: true },
    });
    if (link?.status === "active") return requested;
    // 연결되지 않은 대상 요청은 무시하고 기본 규칙으로 — 조용히 남의 계정에 붙지 않게
    console.warn(`[entitlement] 미연결 혜택 대상 요청 무시: purchaser=${purchaserUserId.slice(0, 8)}`);
  }
  const first = await prisma.expertPatient.findFirst({
    where: { expertUserId: purchaserUserId, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { patientUserId: true },
  });
  return first?.patientUserId ?? purchaserUserId;
}
