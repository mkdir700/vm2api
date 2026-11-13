-- 一次业务审查对应零到多次上游调用。旧调用保留，不补造审查结果。
ALTER TABLE jev_usage_events ADD COLUMN review_id TEXT NOT NULL DEFAULT '';
ALTER TABLE jev_usage_events ADD COLUMN config_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE jev_usage_events ADD COLUMN response_model TEXT NOT NULL DEFAULT '';
ALTER TABLE jev_usage_events ADD COLUMN requested_model TEXT NOT NULL DEFAULT '';
ALTER TABLE jev_usage_events ADD COLUMN upstream_request_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_jev_usage_review ON jev_usage_events(review_id);
CREATE TABLE moderation_reviews (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  config_id TEXT NOT NULL,
  config_revision TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  response_model TEXT NOT NULL,
  result TEXT NOT NULL,
  action TEXT NOT NULL,
  safety_threshold REAL NOT NULL,
  block_if_below INTEGER NOT NULL,
  reason TEXT NOT NULL,
  categories TEXT NOT NULL,
  cache_hit INTEGER NOT NULL,
  source_review_id TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_nano_usd INTEGER,
  known_cost_nano_usd INTEGER NOT NULL,
  unknown_cost_attempts INTEGER NOT NULL
);
CREATE INDEX idx_moderation_reviews_recent ON moderation_reviews(created_at DESC,id DESC);
CREATE INDEX idx_moderation_reviews_model ON moderation_reviews(provider,requested_model,created_at DESC,id DESC);
