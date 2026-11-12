-- Keep the declared per-request kernel receipt across kernel restarts.
ALTER TABLE usage_logs ADD COLUMN kernel_timing TEXT;
