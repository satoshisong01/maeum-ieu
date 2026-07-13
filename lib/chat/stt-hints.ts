/**
 * STT 어휘 힌트 — 동반자 이름·호출어를 전사 프롬프트에 바이어스로 제공해 오인식을 줄인다.
 *
 * 배경(2026-07-10 실기기 검증): "민지야" → "민기야" 등 동반자 이름 오인식이 반복됨.
 * Gemini 전사는 음향만으로 이름을 맞출 수 없으므로, 시스템이 아는 표기를 힌트로 주면
 * 해당 어휘로 수렴한다 (음성인식의 phrase-boosting과 같은 원리).
 *
 * 범위를 의도적으로 좁게 유지 (동반자 이름 + 호출어만):
 * - 가족 이름은 넣지 않는다 — 어르신이 가족 이름을 틀리게 부르는 것 자체가
 *   인지 선별(naming)의 임상 신호인데, STT가 항상 옳은 이름으로 교정하면 신호가 소실된다.
 * - 검진(exam) 턴은 호출부에서 힌트 자체를 제외 — 회상 검사 답안이 힌트로 보정되면 채점 오염.
 *
 * 정책:
 * - STT는 음성 왕복의 최대 병목이라 이 조회는 STT 시작을 막지 않아야 한다
 *   → 호출부에서 promise로 병렬 시작, transcribeAudio 내부에서 await (DB ~수십 ms ≪ STT 수 초).
 * - 실패는 힌트 없이 진행 ("" 반환) — 전사 자체를 막지 않는다.
 */

import { prisma } from "@/lib/prisma";

/** 사용자별 STT 표기 힌트 문자열 생성. 실패/데이터 없음 → "" */
export async function buildSttHints(userId: string): Promise<string> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companionName: true },
    });
    // 인용부호·개행 제거 — companionName은 사용자 입력이라 전사 프롬프트의 따옴표 인용을 깨뜨릴 수 있음
    const companion = user?.companionName?.trim().replace(/["'\n\r]/g, "").slice(0, 20);
    const parts = ['호출어 "마음아"'];
    if (companion) parts.push(`대화 상대(AI)의 이름 "${companion}"`);
    return parts.join(", ");
  } catch (e) {
    console.warn("[stt-hints] failed (proceeding without hints):", (e as Error).message);
    return "";
  }
}
