-- 계층적 요약 (weekly → monthly → yearly) 지원.
-- weekly 4개 → monthly 1개 → 12개 모이면 yearly 1개.

ALTER TABLE conversation_summary
  ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'weekly',  -- 'weekly' | 'monthly' | 'yearly'
  ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES conversation_summary(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
  -- is_active=false: 상위 레벨로 압축된 후 raw weekly는 보존하되 prompt에는 미사용

CREATE INDEX IF NOT EXISTS idx_summary_level ON conversation_summary(user_id, level, period_end DESC) WHERE is_active = true;
