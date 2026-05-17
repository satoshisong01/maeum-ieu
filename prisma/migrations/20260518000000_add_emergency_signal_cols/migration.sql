-- Emergency signal tracking columns on Message
-- 0=정상, 1=관찰(누적), 2=주의(완곡 권유), 3=즉시(응급 안내). null=미평가/AI 발화.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "emergencyLevel" INTEGER;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "emergencyEvidence" TEXT;

-- 보호자 대시보드/실시간 알림 큐 조회 가속 (높은 레벨만 인덱싱)
CREATE INDEX IF NOT EXISTS "Message_emergency_idx"
  ON "Message" ("emergencyLevel", "createdAt" DESC)
  WHERE "emergencyLevel" IS NOT NULL AND "emergencyLevel" >= 2;
