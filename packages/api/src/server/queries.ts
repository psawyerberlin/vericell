import type Database from "better-sqlite3";

interface ProjectRow {
  unid: string;
  title: string;
  source_url: string | null;
  ckb_address: string;
  created_at: string;
  active: number;
  live_tx_hash: string | null;
  live_index: number;
}

interface VersionRow {
  tx_hash: string;
  unid: string;
  version_no: number | null;
  prev_tx_hash: string | null;
  project_sha256: string;
  merkle_root: string | null;
  block_number: number | null;
  block_time: string | null;
  status: string;
}

export interface ProjectRecord {
  unid: string;
  title: string;
  source_url: string | null;
  ckb_address: string;
  created_at: string;
  active: boolean;
  live_tx_hash: string | null;
  live_index: number;
}

export interface VersionRecord {
  tx_hash: string;
  unid: string;
  version_no: number | null;
  prev_tx_hash: string | null;
  project_sha256: string;
  merkle_root: string | null;
  block_number: number | null;
  block_time: string | null;
  status: string;
}

export interface ProjectDetail extends ProjectRecord {
  live_version: VersionRecord | null;
  versions: VersionRecord[];
}

export interface HashMatch {
  unid: string;
  title: string;
  tx_hash: string;
  path: string | null;
  status: string;
  version_no: number | null;
  block_number: number | null;
  block_time: string | null;
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    unid: row.unid,
    title: row.title,
    source_url: row.source_url,
    ckb_address: row.ckb_address,
    created_at: row.created_at,
    active: !!row.active,
    live_tx_hash: row.live_tx_hash,
    live_index: row.live_index,
  };
}

function toVersionRecord(row: VersionRow): VersionRecord {
  return {
    tx_hash: row.tx_hash,
    unid: row.unid,
    version_no: row.version_no,
    prev_tx_hash: row.prev_tx_hash,
    project_sha256: row.project_sha256,
    merkle_root: row.merkle_root,
    block_number: row.block_number,
    block_time: row.block_time,
    status: row.status,
  };
}

export interface ProjectsFilter {
  q?: string;
  hash?: string;
  address?: string;
  active?: boolean;
  page: number;
  limit: number;
}

export interface ProjectListResult {
  rows: ProjectRecord[];
  total: number;
}

/** `hash` matches either a whole-project hash (`versions.project_sha256`) or a file hash (`hashes.sha256`) of any version belonging to the project — TECHNICAL.md §7.1 describes the filter only as "any SHA-256". */
export function listProjects(db: Database.Database, filter: ProjectsFilter): ProjectListResult {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.q) {
    clauses.push("p.title LIKE @q");
    params.q = `%${filter.q}%`;
  }
  if (filter.address) {
    clauses.push("p.ckb_address = @address");
    params.address = filter.address;
  }
  if (filter.active !== undefined) {
    clauses.push("p.active = @active");
    params.active = filter.active ? 1 : 0;
  }
  if (filter.hash) {
    clauses.push(
      `(EXISTS (SELECT 1 FROM versions v WHERE v.unid = p.unid AND v.project_sha256 = @hash)
        OR EXISTS (SELECT 1 FROM hashes h JOIN versions v2 ON v2.tx_hash = h.tx_hash WHERE v2.unid = p.unid AND h.sha256 = @hash))`,
    );
    params.hash = filter.hash;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM projects p ${where}`).get(params) as { n: number }
  ).n;

  const offset = (filter.page - 1) * filter.limit;
  const rows = db
    .prepare(
      `SELECT p.* FROM projects p ${where} ORDER BY p.created_at DESC, p.unid DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: filter.limit, offset }) as ProjectRow[];

  return { rows: rows.map(toProjectRecord), total };
}

export function getProjectDetail(db: Database.Database, unid: string): ProjectDetail | undefined {
  const project = db.prepare("SELECT * FROM projects WHERE unid = ?").get(unid) as
    ProjectRow | undefined;
  if (!project) return undefined;

  const versionRows = db
    .prepare("SELECT * FROM versions WHERE unid = ? ORDER BY version_no ASC, block_number ASC")
    .all(unid) as VersionRow[];
  const versions = versionRows.map(toVersionRecord);
  const liveVersion = versions.find((v) => v.tx_hash === project.live_tx_hash) ?? null;

  return { ...toProjectRecord(project), live_version: liveVersion, versions };
}

export function getVersion(db: Database.Database, txHash: string): VersionRecord | undefined {
  const row = db.prepare("SELECT * FROM versions WHERE tx_hash = ?").get(txHash) as
    VersionRow | undefined;
  return row ? toVersionRecord(row) : undefined;
}

/** Every project/version/path containing `sha256` — as a file hash or as a whole-project hash. */
export function getHashMatches(db: Database.Database, sha256: string): HashMatch[] {
  return db
    .prepare(
      `SELECT p.unid AS unid, p.title AS title, v.tx_hash AS tx_hash, h.path AS path,
              v.status AS status, v.version_no AS version_no,
              v.block_number AS block_number, v.block_time AS block_time
       FROM hashes h
       JOIN versions v ON v.tx_hash = h.tx_hash
       JOIN projects p ON p.unid = v.unid
       WHERE h.sha256 = @sha256
       UNION
       SELECT p.unid AS unid, p.title AS title, v.tx_hash AS tx_hash, NULL AS path,
              v.status AS status, v.version_no AS version_no,
              v.block_number AS block_number, v.block_time AS block_time
       FROM versions v
       JOIN projects p ON p.unid = v.unid
       WHERE v.project_sha256 = @sha256
       ORDER BY block_number DESC`,
    )
    .all({ sha256 }) as HashMatch[];
}

export interface Stats {
  projects: number;
  versions: number;
  hashes: number;
  sync_height: number | null;
}

export function getStats(db: Database.Database): Stats {
  const projects = (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
  const versions = (db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }).n;
  const hashes = (db.prepare("SELECT COUNT(*) AS n FROM hashes").get() as { n: number }).n;
  const sync = db.prepare("SELECT last_block_number FROM sync_state WHERE id = 1").get() as
    { last_block_number: number | null } | undefined;
  return { projects, versions, hashes, sync_height: sync?.last_block_number ?? null };
}
