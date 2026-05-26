-- 대화 요약 테이블 — 시시콜콜한 대화를 LLM이 요약해 장기 기억으로 저장.
-- 목적:
--   1. 토큰 효율: AI가 최근 20턴 + 요약본 1~2개로 충분한 컨텍스트 확보
--   2. 정확도: 천 단위 누적 메시지에서 핵심 정보만 추려서 환각 위험 감소
--   3. 속도: 응답 생성 시 RAG로 매번 검색하던 정보를 요약본에서 즉시 인용
--
-- 주기:
--   - 메시지 100건 누적 시 자동 트리거 (백그라운드)
--   - 또는 manual: backfill-summary.ts 스크립트
--
-- 사용자 격리: user_id 컬럼 + 인덱스로 강제. 절대 사용자 간 누수 없음.

CREATE TABLE IF NOT EXISTS conversation_summary (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES "Conversation"(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,         -- 요약 대상 메시지 시작 시각
  period_end TIMESTAMPTZ NOT NULL,           -- 요약 대상 메시지 종료 시각
  summary TEXT NOT NULL,                     -- 자연어 요약 (300~600자)
  key_facts TEXT,                            -- 핵심 사실 JSON 문자열 (가족 언급/일상/사건)
  message_count INT NOT NULL,                -- 요약된 메시지 개수
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_summary_user ON conversation_summary(user_id);
CREATE INDEX IF NOT EXISTS idx_summary_user_period ON conversation_summary(user_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_summary_conv ON conversation_summary(conversation_id, period_end DESC);
