ALTER TABLE posts ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending', 'completed', 'failed'));
ALTER TABLE posts ADD COLUMN ai_model TEXT;
ALTER TABLE posts ADD COLUMN ai_raw_response TEXT;
ALTER TABLE posts ADD COLUMN confidence REAL;
ALTER TABLE posts ADD COLUMN review_reason TEXT;
ALTER TABLE posts ADD COLUMN privacy_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN abuse_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN defamation_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN sensitive_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN manual_review_by_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN requires_manual_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved' CHECK (review_status IN ('draft', 'analyzing', 'manual_review', 'approved', 'rejected', 'ai_failed'));
ALTER TABLE posts ADD COLUMN reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN rejection_reason TEXT;
ALTER TABLE posts ADD COLUMN reviewed_at INTEGER;

ALTER TABLE comments ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending', 'completed', 'failed'));
ALTER TABLE comments ADD COLUMN ai_model TEXT;
ALTER TABLE comments ADD COLUMN ai_raw_response TEXT;
ALTER TABLE comments ADD COLUMN confidence REAL;
ALTER TABLE comments ADD COLUMN review_reason TEXT;
ALTER TABLE comments ADD COLUMN privacy_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN abuse_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN defamation_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN sensitive_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN manual_review_by_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN requires_manual_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved' CHECK (review_status IN ('draft', 'analyzing', 'manual_review', 'approved', 'rejected', 'ai_failed'));
ALTER TABLE comments ADD COLUMN reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE comments ADD COLUMN rejection_reason TEXT;
ALTER TABLE comments ADD COLUMN reviewed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_posts_review_status ON posts(review_status);
CREATE INDEX IF NOT EXISTS idx_posts_ai_status ON posts(ai_status);
CREATE INDEX IF NOT EXISTS idx_comments_review_status ON comments(review_status);
CREATE INDEX IF NOT EXISTS idx_comments_ai_status ON comments(ai_status);

UPDATE posts
SET ai_status = 'completed',
    review_status = 'approved',
    reviewed_at = COALESCE(reviewed_at, created_at)
WHERE ai_status = 'pending' OR review_status = 'approved';

UPDATE comments
SET ai_status = 'completed',
    review_status = 'approved',
    reviewed_at = COALESCE(reviewed_at, created_at)
WHERE ai_status = 'pending' OR review_status = 'approved';
