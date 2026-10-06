/**
 * 사용자모드 질문 풀 로더 — scripts/generate-question-bank.mjs가 만든 정적 JSON에서
 * 영역별로 질문을 샘플링. 런타임 생성 X(미리 만들어 둔 풀에서 뽑기만 함).
 * 풀이 비었거나 해당 영역이 없으면 빈 배열 → 호출부는 기존 LLM 자체 출제로 폴백.
 */
import bankData from "./question-bank.json";

export interface BankQuestion {
  text: string;
  hint: string;
}
interface BankItem {
  domain: string;
  itemType: string;
  source: string;
  measure?: string;
  questions: BankQuestion[];
}
interface QuestionBank {
  generatedAt?: string;
  model?: string;
  items: Record<string, BankItem>;
}

const bank = bankData as QuestionBank;

/**
 * 어르신이 **하지 않은 말·일을 전제**하는 문항인가 — "어제 마실 다녀오셨다 그러셨잖아요", "손녀가 용돈 주고 갔다던데".
 *
 * 결함(2026-10-06 직접 운전 B13): 확인 질문 "요번 주 손녀가 용돈 쥐여주고 갔다던데, 언제였어요?"에 어르신이
 *   "그런 일 없었는데… 내가 그런 말을 했었나? 요새 내가 정신이 없나 보네"라고 답했다. 정적 풀은 대화 내용을 모르니
 *   이런 전제는 늘 지어낸 것이다 — 기억이 걱정되는 분이 자기 기억을 의심하게 만들고, 바른 부정이 회상 실패로
 *   오채점될 위험도 있다. 풀 3,888개 중 124개(최근 일 회상은 100개 중 46개)가 해당해 추출 단계에서 거른다.
 */
const PRESUPPOSES_UNSAID = /그러셨던|그러셨잖|다던데|셨다면서|셨다며|다녀가셨다|셨잖아요|말씀하셨던/;
export function presupposesUnsaid(text: string): boolean {
  return PRESUPPOSES_UNSAID.test(text);
}

/** 해당 영역의 모든 항목 질문을 합친 풀 — 전제형 문항은 뺀다(위 presupposesUnsaid) */
function poolForDomain(domain: string): BankQuestion[] {
  return Object.values(bank.items)
    .filter((it) => it.domain === domain)
    .flatMap((it) => it.questions)
    .filter((q) => !presupposesUnsaid(q.text));
}

/** 영역에서 서로 다른 질문 n개를 무작위 추출(반복 회피용 다양화). 없으면 빈 배열. */
export function sampleQuestionsForDomain(domain: string, n: number): BankQuestion[] {
  const pool = poolForDomain(domain);
  if (pool.length === 0) return [];
  const count = Math.min(n, pool.length);
  const used = new Set<number>();
  const picked: BankQuestion[] = [];
  let guard = 0;
  while (picked.length < count && guard < count * 20) {
    guard++;
    const i = Math.floor(Math.random() * pool.length);
    if (used.has(i)) continue;
    used.add(i);
    picked.push(pool[i]);
  }
  return picked;
}

/** 풀에 질문이 하나라도 있는지(생성 완료 여부 게이트) */
export function isBankReady(): boolean {
  return Object.values(bank.items).some((it) => it.questions.length > 0);
}
