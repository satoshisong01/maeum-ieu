-- 보호자 알림 대상 컬럼 + 알림 발송 시각 컬럼
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "guardianEmail" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "guardianWebhookUrl" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);
