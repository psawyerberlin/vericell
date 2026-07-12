-- Phase 9 load-sanity finding: `queries.ts`'s getHashMatches (backs both
-- GET /hashes/{sha256} and GET /verify/{sha256}) UNIONs a lookup by
-- hashes.sha256 (already indexed, idx_hashes_sha from 0001_init.sql) with a
-- lookup by versions.project_sha256 — which had no index at all, so that
-- half of the query fell back to a full table scan of `versions` on every
-- request. Not part of TECHNICAL.md §6 verbatim (an index, not a schema
-- deviation), same rationale as idx_hashes_sha itself.
CREATE INDEX idx_versions_project_sha256 ON versions (project_sha256);
