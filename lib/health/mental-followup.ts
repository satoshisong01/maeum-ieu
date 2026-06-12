/**
 * T3 후속 케어 — 재접속 인사에 끼워 넣는 마음 건강 후속 힌트.
 *
 *  1) 위기 후속 체크인: 최근 7일 내 완료 세션에 crisis(9번 자해사고 양성)가 있으면
 *     인사에서 오늘 마음을 따뜻하게 1회 확인 (검사·전화번호 강요 금지 — 부담 주지 않기).
 *  2) 주기 재검 권유: 마지막 완료 검진이 14일 이상 지났으면 가볍게 재점검 1회 제안.
 *     저장소 없는 디바운스: 경과일이 14일 주기 창(14~15, 28~29, …)에 들어올 때만 권유
 *     — 매 접속마다 반복 제안되는 부담 방지.
 *
 * 실패는 null로 무해화 — 인사 자체를 막지 않는다.
 */
import { prisma } from "@/lib/prisma";

interface LastSession { scale: string; severity: string | null; crisis: boolean; days_ago: number }

export async function getMentalFollowupHint(userId: string): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<LastSession[]>(
      `SELECT scale, severity, crisis,
              EXTRACT(EPOCH FROM (now() - updated_at))::float / 86400 AS days_ago
         FROM mental_session
        WHERE user_id = $1 AND status = 'done'
        ORDER BY updated_at DESC LIMIT 1`, userId);
    const last = rows[0];
    if (!last) return null;

    const days = Math.floor(last.days_ago);
    if (last.crisis && days <= 7) {
      return `\n[마음 후속 체크인 — 필수 1문장] 지난 마음 점검(${days === 0 ? "오늘" : `${days}일 전`})에서 힘든 생각이 든다고 답하셨던 분이에요. 인사에 이어 오늘 마음은 좀 어떠신지 한 문장으로만 따뜻하게 물어봐 주세요. 검사 재촉·상담전화 언급은 하지 마세요(부담 금지).`;
    }
    // 14일 주기 창(주기 시작 후 2일)에서만 권유 — 저장소 없는 디바운스
    if (days >= 14 && (days - 14) % 14 <= 1) {
      return `\n[재검 권유 — 가볍게 1회만] 마지막 마음 건강 체크가 ${days}일 전이에요. 인사 후 "요즘 마음은 어떠세요? 마음 건강 체크 한번 더 해보실래요?"처럼 자연스럽게 한 번만 권해 주세요. 싫다고 하면 바로 수긍하세요.`;
    }
    return null;
  } catch {
    return null;
  }
}
