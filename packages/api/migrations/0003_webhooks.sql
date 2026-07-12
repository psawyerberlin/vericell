-- Phase 6: webhooks (TECHNICAL.md §7.3). `webhooks` already exists verbatim
-- from 0001_init.sql (id, key_hash, unid, url, events) but has nowhere to
-- keep the HMAC signing secret §7.3 requires ("deliveries are signed with
-- an HMAC header so receivers can authenticate the callback") — added here
-- rather than deviating from the verbatim §6 table. Unlike `api_keys.key_hash`
-- (only ever compared for equality, so a one-way hash suffices), the secret
-- must be readable back at delivery time to *compute* each HMAC, so it is
-- stored in cleartext — see DECISIONS.md.
ALTER TABLE webhooks ADD COLUMN secret TEXT NOT NULL DEFAULT '';
ALTER TABLE webhooks ADD COLUMN created_at TEXT;

-- DB-backed delivery queue (ClaudeCodeInstruction.md Phase 6: "simple
-- DB-backed queue"). Not in TECHNICAL.md §6 verbatim — an implementation
-- detail of the dispatcher, not a schema deviation.
CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id),
  event           TEXT NOT NULL,        -- committed | consumed | superseded
  unid            TEXT,
  tx_hash         TEXT,
  payload         TEXT NOT NULL,        -- JSON-encoded body sent verbatim (signed as-is)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
