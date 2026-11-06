-- Keep the proxy identity and binding model. Runtime readiness is never persisted here.
ALTER TABLE proxies ADD COLUMN managed_config TEXT;
ALTER TABLE proxies ADD COLUMN managed_host_id TEXT;
CREATE UNIQUE INDEX idx_managed_egress_host_port
  ON proxies(managed_host_id, port) WHERE managed_config IS NOT NULL;
