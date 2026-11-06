-- A pending removal reserves its port until the new runtime configuration is verified.
ALTER TABLE proxies ADD COLUMN managed_delete_pending INTEGER NOT NULL DEFAULT 0 CHECK (managed_delete_pending IN (0, 1));
