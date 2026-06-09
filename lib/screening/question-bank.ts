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

/** 해당 영역의 모든 항목 질문을 합친 풀 */
function poolForDomain(domain: string): BankQuestion[] {
  return Object.values(bank.items)
    .filter((it) => it.domain === domain)
    .flatMap((it) => it.questions);
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
