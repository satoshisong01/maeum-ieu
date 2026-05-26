-- Phase 1: 구조화된 사용자 프로필 — prompt에 의존하지 않고 정확한 사실 슬롯으로 관리
--
-- 배경 (2026-05-26): RAG + prompt만으로는 LLM 환각 차단 불가.
-- 예: rudtjrch@naver.com 첫 인사에 abc@abc.com의 가족 정보(재미/영민)가 노출되는 사고 발생.
-- → 사용자별 핵심 사실을 명시적 슬롯으로 저장하고, 응답 fact-check 시 cross-check.
--
-- 주의: raw SQL 관리. prisma schema에 추가하면 `prisma db push`가 drop 위험.
-- (cognitive_assessments / message_embeddings와 같은 패턴)

-- 1) UserProfile: 사용자별 메타 정보 (1:1)
CREATE TABLE IF NOT EXISTS user_profile (
  user_id TEXT PRIMARY KEY REFERENCES "User"(id) ON DELETE CASCADE,
  hometown TEXT,                 -- 고향 (예: '김해')
  residence TEXT,                -- 현 거주지 (예: '동탄')
  spouse_status TEXT,            -- 'bereaved' | 'alive' | 'divorced' | 'single' | NULL
  spouse_name TEXT,              -- 배우자 이름/호칭 (예: '안사람')
  occupation TEXT,               -- 직업 (현재 또는 과거)
  hobbies TEXT,                  -- 취미 (콤마 구분: '화초,라디오,산책')
  favorite_foods TEXT,           -- 좋아하는 음식 (콤마 구분: '비빔국수,칼국수')
  health_notes TEXT,             -- 건강 메모 (자유형, 예: '무릎 시큰, 잠 4시 깸')
  notes TEXT,                    -- 기타 자유 메모
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) FamilyMember: 가족 구성원 (N:1)
CREATE TABLE IF NOT EXISTS family_member (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,            -- '영민', '재미', '아내'
  relation TEXT NOT NULL,        -- 'son' | 'daughter' | 'grandchild' | 'spouse' | 'sibling' | 'nephew' | 'niece' | 'parent' | 'other'
  order_idx INT,                 -- 같은 relation 안에서 순서 (1=첫째, 2=둘째). NULL 가능.
  notes TEXT,                    -- 성격/특징 (예: '무뚝뚝하지만 속이 깊음')
  source_message_id TEXT,        -- 추출된 원본 메시지 ID (traceability)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)          -- 같은 사용자 안에서 이름 중복 방지
);

CREATE INDEX IF NOT EXISTS idx_family_user ON family_member(user_id);
CREATE INDEX IF NOT EXISTS idx_family_relation ON family_member(user_id, relation);

-- 3) UserFact: 자유형 key-value 사실 슬롯 (N:1)
--   UserProfile에 정형화하기 어려운 임의 사실 저장.
--   예: ('favorite_drama', '전원일기'), ('plant', '제라늄,백일홍'), ('birthplace_year', '1956')
CREATE TABLE IF NOT EXISTS user_fact (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,  -- 0~1 (LLM 또는 패턴 추출 신뢰도)
  source_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_userfact_user ON user_fact(user_id);
