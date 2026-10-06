/**
 * 검진 '문답 기록' 재구성 — **exam_item_score에서만** 만든다(메시지 테이블을 읽지 않는다).
 *
 * 왜: 예전엔 검진 시작~종료 사이의 **모든** 메시지를 문답 기록으로 보여줘, 그 창 안의 일상 대화·
 *   상시 감시 혼잣말이 전문가 화면에 원문째 노출됐다(2026-10-06 적대 감사, 동의서 §4 위반).
 *   exam_item_score는 검진 경로만 쓰므로 일상 대화가 구조적으로 섞일 수 없다.
 *
 * 저장 구조: 영역(domain) 하나를 물으면 그 영역의 문항마다 한 행이 생기고, 행들은 **같은 답**을 공유한다
 *   (app/api/chat/route.ts handleExamTurn → scoreDomainAnswer). 환자가 들은 질문은 그 영역 문항
 *   프롬프트를 이어 붙인 문장이다(lib/screening/exam-runner.ts renderDomainBattery와 같은 규칙).
 *   그래서 "같은 영역 + 같은 답"으로 이어진 행을 한 번의 문답으로 묶는다.
 */
export interface ExamItemRow {
  domain: string;
  prompt: string | null;
  answer: string | null;
  created_at: Date;
}

export interface ExamQaBubble {
  role: "assistant" | "user";
  content: string;
  at: string;
}

export function buildExamQa(rows: readonly ExamItemRow[]): ExamQaBubble[] {
  const out: ExamQaBubble[] = [];
  let i = 0;
  while (i < rows.length) {
    const domain = rows[i].domain;
    const answer = rows[i].answer ?? "";
    const group: ExamItemRow[] = [];
    while (i < rows.length && rows[i].domain === domain && (rows[i].answer ?? "") === answer) {
      group.push(rows[i]);
      i++;
    }
    const at = new Date(group[0].created_at).toISOString();
    const question = group.map((g) => (g.prompt ?? "").trim()).filter(Boolean).join(" ");
    if (question) out.push({ role: "assistant", content: question, at });
    out.push({ role: "user", content: answer.trim() || "(무응답)", at });
  }
  return out;
}
