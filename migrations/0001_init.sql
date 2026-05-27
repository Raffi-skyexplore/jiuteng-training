CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  club_name TEXT,
  display_name TEXT,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  points_balance INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  description TEXT NOT NULL,
  image_blob BLOB NOT NULL,
  image_mime TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  image_size INTEGER NOT NULL,
  ai_status TEXT NOT NULL CHECK (ai_status IN ('pending', 'completed', 'failed')),
  ai_model TEXT,
  ai_raw_response TEXT,
  welfare_type TEXT,
  confidence REAL,
  suggested_points INTEGER,
  review_reason TEXT,
  privacy_risk INTEGER NOT NULL DEFAULT 0,
  blur_risk INTEGER NOT NULL DEFAULT 0,
  web_image_risk INTEGER NOT NULL DEFAULT 0,
  duplicate_risk INTEGER NOT NULL DEFAULT 0,
  manual_review_by_ai INTEGER NOT NULL DEFAULT 0,
  requires_manual_review INTEGER NOT NULL DEFAULT 1,
  review_status TEXT NOT NULL CHECK (review_status IN ('analyzing', 'auto_approved', 'manual_review', 'approved', 'rejected', 'ai_failed')),
  reviewed_by TEXT,
  review_note TEXT,
  rejection_reason TEXT,
  awarded_points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  analyzed_at INTEGER,
  reviewed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_review_status ON submissions(review_status);
CREATE INDEX IF NOT EXISTS idx_submissions_image_sha256 ON submissions(image_sha256);
CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at);

CREATE TABLE IF NOT EXISTS points_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  submission_id TEXT,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_points_ledger_user_id ON points_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_points_ledger_created_at ON points_ledger(created_at);

CREATE TABLE IF NOT EXISTS rewards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  points_cost INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exchange_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reward_id TEXT NOT NULL,
  reward_name TEXT NOT NULL,
  points_cost INTEGER NOT NULL,
  contact_info TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'fulfilled', 'rejected')) DEFAULT 'submitted',
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  processed_by TEXT,
  admin_note TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reward_id) REFERENCES rewards(id) ON DELETE CASCADE,
  FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_exchange_requests_user_id ON exchange_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_exchange_requests_created_at ON exchange_requests(created_at);
