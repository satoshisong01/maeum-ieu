/**
 * 상시 감시(관찰자 모드) 기록의 표지 — **단일 출처.**
 *
 * 상시 감시 조각은 응급 dedup·알림 마킹이 Message 행에 의존하므로 대화와 같은 테이블에
 * `role: "user"`로 저장된다(app/api/observe/turn). 그래서 **대화를 읽는 모든 곳이 이 표지로
 * 걸러야** 한다. 대화가 아니라 혼잣말이고, 수집 목적도 "응급만"이다.
 *
 * 결함(2026-10-06 적대 감사): 표지 문자열이 소비처마다 리터럴로 흩어져 있었고, 4곳 중 2곳만 걸렀다.
 *   · 걸렀던 곳: 동반자 대화 컨텍스트(chat/route), 대화 목록 응답(conversations/route)
 *   · 안 걸렀던 곳:
 *     - 일일 대화 한도 — 감시를 켜 두면 혼잣말 조각이 한도(기본 100)를 채워, 그날 어르신이
 *       동반자와 대화하려 하면 마무리 인사만 돌아왔다(인지 선별도 그날 0건)
 *     - 대화 요약 롤업 — 혼잣말이 "지난 대화 요약"이 되어 동반자 프롬프트의 기억으로 들어갔다
 *       (목적 외 사용이고, 조각 수만큼 유료 요약이 자주 돌았다)
 *     - Live 인지 분석 이력 — 질문-답 짝이 맞지 않는 혼잣말로 채점 맥락이 채워졌다
 *   표지가 흩어지면 새 소비처는 거르는 걸 잊는다(가이드 F3). 쓰는 곳도 읽는 곳도 이 모듈만 쓴다.
 */
export const OBSERVATION_PREFIX = "[관찰]";

/** 저장할 관찰 기록 본문 — 표지를 붙인다 */
export function toObservationContent(text: string): string {
  return `${OBSERVATION_PREFIX} ${text}`;
}

/** 이 메시지 본문이 상시 감시 기록인가 */
export function isObservationContent(content: string | null | undefined): boolean {
  return typeof content === "string" && content.startsWith(OBSERVATION_PREFIX);
}

/** Prisma where 절 조각 — 관찰 기록을 뺀다. `where: { ..., ...EXCLUDE_OBSERVATION }` */
export const EXCLUDE_OBSERVATION = { NOT: { content: { startsWith: OBSERVATION_PREFIX } } } as const;
