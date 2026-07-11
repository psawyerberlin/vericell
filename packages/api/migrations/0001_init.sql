-- TECHNICAL.md §6, verbatim except for the SQLite dialect note called out
-- there: TIMESTAMPTZ columns become TEXT storing ISO-8601 strings.
CREATE TABLE projects (
  unid          TEXT PRIMARY KEY,     -- type ID args (or genesis tx hash)
  title         TEXT NOT NULL,
  source_url    TEXT,
  ckb_address   TEXT NOT NULL,        -- owner lock as address
  created_at    TEXT NOT NULL,        -- block timestamp of first version (ISO-8601)
  active        BOOLEAN NOT NULL,     -- true while a live cell exists
  live_tx_hash  TEXT,
  live_index    INTEGER DEFAULT 0
);

CREATE TABLE versions (
  tx_hash        TEXT PRIMARY KEY,
  unid           TEXT REFERENCES projects(unid),
  version_no     INTEGER,
  prev_tx_hash   TEXT,
  project_sha256 TEXT NOT NULL,
  merkle_root    TEXT,
  block_number   BIGINT,
  block_time     TEXT,                -- ISO-8601
  status         TEXT NOT NULL,       -- pending | committed | consumed
  consumed_at_block BIGINT            -- block_number of the tx that consumed this cell, if any;
                                       -- not in TECHNICAL.md §6 verbatim — needed to precisely
                                       -- undo a consumption on reorg rollback (see DECISIONS.md)
);

-- backward search: any file hash → project (the "SHA-256 list" requirement)
CREATE TABLE hashes (
  sha256   TEXT NOT NULL,
  tx_hash  TEXT REFERENCES versions(tx_hash),
  path     TEXT,
  PRIMARY KEY (sha256, tx_hash, path)
);
CREATE INDEX idx_hashes_sha ON hashes (sha256);

CREATE TABLE api_keys (
  key_hash    TEXT PRIMARY KEY,       -- store only the hash of the key
  label       TEXT,
  created_at  TEXT,
  rate_limit  INTEGER DEFAULT 60
);

CREATE TABLE webhooks (
  id        TEXT PRIMARY KEY,
  key_hash  TEXT REFERENCES api_keys(key_hash),
  unid      TEXT,                     -- NULL = all projects of this key
  url       TEXT NOT NULL,
  events    TEXT NOT NULL             -- committed,consumed,superseded
);

CREATE TABLE sync_state (             -- indexer cursor, reorg-safe
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_block_number BIGINT,
  last_block_hash   TEXT
);

INSERT INTO sync_state (id, last_block_number, last_block_hash) VALUES (1, NULL, NULL);
