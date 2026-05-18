-- 화자 라벨링 — primary/visitor/unknown. 인지 분석 집계에서 visitor 제외 가능.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "speakerLabel" TEXT;

CREATE INDEX IF NOT EXISTS "Message_speakerLabel_idx"
  ON "Message" ("speakerLabel")
  WHERE "speakerLabel" IS NOT NULL;
