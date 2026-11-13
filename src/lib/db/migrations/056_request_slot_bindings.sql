CREATE TABLE request_slot_bindings (
  request_key TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  cache_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE request_slot_executions (
  request_key TEXT NOT NULL REFERENCES request_slot_bindings(request_key),
  context_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting_tools', 'complete', 'uncertain')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (request_key, context_key)
);
CREATE INDEX request_slot_execution_session ON request_slot_executions(session_id, state);
