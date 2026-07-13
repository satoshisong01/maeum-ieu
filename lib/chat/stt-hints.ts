/**
 * STT 어휘 힌트 — 사용자별 고유명사(호출어·동반자 이름·가족 이름)를 전사 프롬프트에
 * 바이어스로 제공해 발음 오인식을 줄인다.
 *
 * 배경(2026-07-10 실기기 검증): "민지야" → "민기야" 등 고유명사 오인식이 반복됨.
 * Gemini 전사는 음향만으로 이름을 맞출 수 없으므로, 시스템이 아는 표기를 힌트로 주면
 * 해당 어휘로 수렴한다 (음성인식의 phrase-boosting과 같은 원리).
 *
 * 가족 이름 포함 근거(2026-07-10 저녁, 사용자 결정 — 사람마다 발음·사투리가 달라 보정 필요):
 * - 치매의 이름 혼동은 대개 "다른 진짜 이름"(음향적으로 먼 소리)이라 표기 힌트로 뒤집히지 않고,
 *   STT 오인식은 발음-근접 왜곡("영수"→"연수")이라 힌트가 정확히 이것만 교정한다
 *   → 잡음은 지우고 임상 신호(naming)는 보존. 프롬프트도 "명백히 일치할 때만"으로 제한.
 * - 정식 이름대기·회상 채점이 있는 검진(exam) 턴은 호출부에서 힌트 자체를 제외(채점 오염 방지).
 *
 * 정책:
 * - STT는 음성 왕복의 최대 병목이라 이 조회는 STT 시작을 막지 않아야 한다
 *   → 호출부에서 promise로 병렬 시작, transcribeAudio 내부에서 await (DB ~수십 ms ≪ STT 수 초).
 * - 실패는 힌트 없이 진행 ("" 반환) — 전사 자체를 막지 않는다.
 */

import { prisma } from "@/lib/prisma";

/** 사용자 입력 이름의 프롬프트 위생 처리 — 인용부호·개행이 전사 프롬프트 인용을 깨는 것 방지 */
function sanitizeName(name: string | null | undefined): string {
  return (name || "").trim().replace(/["'\n\r]/g, "").slice(0, 20);
}

/** 사용자별 STT 표기 힌트 문자열 생성. 실패/데이터 없음 → "" */
export async function buildSttHints(userId: string): Promise<string> {
  try {
    const [user, family] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { companionName: true },
      }),
      prisma.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM family_member WHERE user_id = $1 ORDER BY relation, order_idx NULLS LAST, name LIMIT 12`,
        userId,
      ),
    ]);

    const companion = sanitizeName(user?.companionName);
    const familyNames = new Set<string>();
    for (const f of family) {
      const n = sanitizeName(f.name);
      // 호칭형("큰아들" 등)이 이름 슬롯에 들어간 경우는 힌트 가치 없음 — 2글자 이상 실명만
      if (n.length >= 2 && n !== companion && !/^(아들|딸|큰|작은|막내|첫째|둘째|셋째|손주|손자|손녀|영감|할멈)/.test(n)) {
        familyNames.add(n);
      }
    }

    const parts = ['호출어 "마음아"'];
    if (companion) parts.push(`대화 상대(AI)의 이름 "${companion}"`);
    if (familyNames.size > 0) {
      // "명백히 일치할 때만" — 발음이 다른 이름을 이 표기로 치환(임상 naming 신호 소실)하지 않도록 제한
      parts.push(`주변 인물 이름(발음이 명백히 일치할 때만 이 표기 사용): ${[...familyNames].join(", ")}`);
    }
    return parts.join(". ");
  } catch (e) {
    console.warn("[stt-hints] failed (proceeding without hints):", (e as Error).message);
    return "";
  }
}
