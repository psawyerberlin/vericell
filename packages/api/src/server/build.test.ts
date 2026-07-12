import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db/open.js";
import { buildServer, type TypedApp } from "./build.js";
import { FIXTURE, fakeFetchProof, fakeGetTip, seedFixtureDb } from "./testFixtures.js";

function setup(rateLimitMax = 1000): TypedApp {
  const db = openDb(":memory:");
  seedFixtureDb(db);
  return buildServer({
    db,
    network: "devnet",
    fetchProof: fakeFetchProof(),
    getTip: fakeGetTip(120n),
    rateLimit: { max: rateLimitMax, timeWindow: "1 minute" },
  });
}

describe("GET /api/v1/projects", () => {
  let app: TypedApp;
  beforeEach(() => {
    app = setup();
  });

  it("lists projects with pagination envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.data).toHaveLength(3);
  });

  it("filters by q (title substring)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects?q=Beta" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].unid).toBe(FIXTURE.beta.unid);
  });

  it("filters by address", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects?address=${FIXTURE.gamma.address}`,
    });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].unid).toBe(FIXTURE.gamma.unid);
  });

  it("filters by active=false", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects?active=false" });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].unid).toBe(FIXTURE.gamma.unid);
  });

  it("filters by hash (file hash of a specific version)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects?hash=${FIXTURE.alpha.fileHash2}`,
    });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].unid).toBe(FIXTURE.alpha.unid);
  });

  it("paginates with page/limit", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects?page=2&limit=1" });
    const body = res.json();
    expect(body.page).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.total_pages).toBe(3);
  });

  it("400s on an out-of-range limit", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects?limit=101" });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json();
    expect(body.status).toBe(400);
    expect(body.title).toBe("Bad Request");
  });

  it("400s on a malformed hash filter", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects?hash=not-a-hash" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/projects/:unid", () => {
  let app: TypedApp;
  beforeEach(() => {
    app = setup();
  });

  it("returns the project with live version and full version chain", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${FIXTURE.alpha.unid}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unid).toBe(FIXTURE.alpha.unid);
    expect(body.versions).toHaveLength(2);
    expect(body.live_version.tx_hash).toBe(FIXTURE.alpha.v2TxHash);
  });

  it("404s for an unknown unid", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json();
    expect(body.status).toBe(404);
    expect(body.instance).toBe("/api/v1/projects/nope");
  });
});

describe("GET /api/v1/versions/:txHash", () => {
  let app: TypedApp;
  beforeEach(() => {
    app = setup();
  });

  it("indexed version: source = index, decorated with chain manifest", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${FIXTURE.alpha.v2TxHash}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("index");
    expect(body.status).toBe("committed");
    expect(body.version_no).toBe(2);
    expect(body.prev_tx_hash).toBe(FIXTURE.alpha.v1TxHash);
    expect(body.manifest.title).toBe("Alpha Project");
    expect(body.live).toBe(true);
    expect(body.owner_address).toBe(FIXTURE.alpha.address);
  });

  it("unindexed proof: falls back to chain, source = chain", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/versions/${FIXTURE.unindexedTxHash}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("chain");
    expect(body.status).toBe("committed");
    expect(body.version_no).toBeNull();
    expect(body.manifest.title).toBe("Unindexed Project");
    expect(body.live).toBe(true);
  });

  it("404s when neither indexed nor found on chain", async () => {
    const missing = "0x" + "9".repeat(64);
    const res = await app.inject({ method: "GET", url: `/api/v1/versions/${missing}` });
    expect(res.statusCode).toBe(404);
  });

  it("400s on a malformed tx hash", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/versions/not-a-tx-hash" });
    expect(res.statusCode).toBe(400);
  });

  it("indexed version still 200s (serving indexed data only) when the chain lookup itself fails", async () => {
    const db = openDb(":memory:");
    seedFixtureDb(db);
    const failingApp = buildServer({
      db,
      network: "devnet",
      fetchProof: async () => {
        throw new Error("RPC unreachable");
      },
      getTip: fakeGetTip(120n),
      rateLimit: { max: 1000, timeWindow: "1 minute" },
    });

    const res = await failingApp.inject({
      method: "GET",
      url: `/api/v1/versions/${FIXTURE.alpha.v2TxHash}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("index");
    expect(body.status).toBe("committed");
    expect(body.manifest).toBeNull(); // chain lookup failed, so no manifest to decorate with
  });

  it("502s an unindexed tx hash when the chain lookup itself fails (nothing to fall back to)", async () => {
    const db = openDb(":memory:");
    seedFixtureDb(db);
    const failingApp = buildServer({
      db,
      network: "devnet",
      fetchProof: async () => {
        throw new Error("RPC unreachable");
      },
      getTip: fakeGetTip(120n),
      rateLimit: { max: 1000, timeWindow: "1 minute" },
    });

    const res = await failingApp.inject({
      method: "GET",
      url: `/api/v1/versions/${FIXTURE.unindexedTxHash}`,
    });
    expect(res.statusCode).toBe(502);
  });
});

describe("GET /api/v1/hashes/:sha256", () => {
  let app: TypedApp;
  beforeEach(() => {
    app = setup();
  });

  it("finds every project/version/path containing the hash", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/hashes/${FIXTURE.alpha.fileHash}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matches).toHaveLength(2);
    expect(body.matches.map((m: { tx_hash: string }) => m.tx_hash).sort()).toEqual(
      [FIXTURE.alpha.v1TxHash, FIXTURE.alpha.v2TxHash].sort(),
    );
  });

  it("returns an empty match list for an unknown hash (200, not 404)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/hashes/${"0".repeat(64)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().matches).toEqual([]);
  });

  it("400s on a malformed sha256", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/hashes/short" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/verify/:sha256", () => {
  let app: TypedApp;
  beforeEach(() => {
    app = setup();
  });

  it("verdict for a hash still live in the current version", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/verify/${FIXTURE.alpha.fileHash}`,
    });
    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.live).toBe(true);
    expect(body.project.unid).toBe(FIXTURE.alpha.unid);
    expect(body.version.tx_hash).toBe(FIXTURE.alpha.v2TxHash);
    expect(body.path).toBe("a.txt");
  });

  it("verdict for a hash only in a consumed (withdrawn) version", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/verify/${FIXTURE.gamma.fileHash}`,
    });
    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.live).toBe(false);
  });

  it("not found verdict for an unknown hash", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/verify/${"0".repeat(64)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      found: false,
      live: false,
      project: null,
      version: null,
      block_time: null,
      path: null,
    });
  });

  it("400s on a malformed sha256", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/verify/short" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/stats", () => {
  it("reports totals and sync height", async () => {
    const app = setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe("devnet");
    expect(body.projects).toBe(3);
    expect(body.versions).toBe(4);
    expect(body.hashes).toBe(5);
    expect(body.sync_height).toBe(FIXTURE.syncState.lastBlockNumber);
  });
});

describe("GET /api/v1/health", () => {
  it("reports indexer lag = tip - cursor", async () => {
    const app = setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.network).toBe("devnet");
    expect(body.indexer.cursor).toBe(FIXTURE.syncState.lastBlockNumber);
    expect(body.indexer.tip).toBe(120);
    expect(body.indexer.lag).toBe(20);
    expect(body.indexer.chain_reachable).toBe(true);
  });

  it("stays 200 with chain_reachable=false when the chain tip lookup fails", async () => {
    const db = openDb(":memory:");
    seedFixtureDb(db);
    const app = buildServer({
      db,
      network: "devnet",
      fetchProof: fakeFetchProof(),
      getTip: async () => {
        throw new Error("rpc down");
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.indexer.chain_reachable).toBe(false);
    expect(body.indexer.lag).toBeNull();
  });
});

describe("OpenAPI docs", () => {
  it("serves the spec at /api/v1/openapi.json", async () => {
    const app = setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBe("3.1.0");
    // Phase 10a: `servers` declares the /api/v1 base (TECHNICAL.md's network
    // path parameter), so paths are relative to it — the alias ("/projects")
    // and this server's own network-prefixed tree ("/devnet/projects") both
    // show up, since `setup()`'s single binding is network "devnet".
    expect(body.servers.some((s: { url: string }) => s.url === "/api/v1")).toBe(true);
    expect(body.paths["/projects"]).toBeDefined();
    expect(body.paths["/versions/{txHash}"]).toBeDefined();
    expect(body.paths["/devnet/projects"]).toBeDefined();
  });

  it("serves the docs UI at /api/v1/docs", async () => {
    const app = setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/docs" });
    expect([200, 302]).toContain(res.statusCode);
  });
});

describe("rate limiting", () => {
  it("429s after the per-IP limit and responds as problem+json", async () => {
    const db = openDb(":memory:");
    seedFixtureDb(db);
    const app = buildServer({
      db,
      network: "devnet",
      fetchProof: fakeFetchProof(),
      getTip: fakeGetTip(),
      rateLimit: { max: 2, timeWindow: "1 minute" },
    });

    const ok1 = await app.inject({ method: "GET", url: "/api/v1/stats" });
    const ok2 = await app.inject({ method: "GET", url: "/api/v1/stats" });
    const limited = await app.inject({ method: "GET", url: "/api/v1/stats" });

    expect(ok1.statusCode).toBe(200);
    expect(ok2.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["content-type"]).toContain("application/problem+json");
    const body = limited.json();
    expect(body.status).toBe(429);
    expect(body.title).toBe("Too Many Requests");
  });
});

describe("CORS", () => {
  it("allows cross-origin GET", async () => {
    const app = setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/stats",
      headers: { origin: "https://example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });
});

describe("404 fallback", () => {
  it("returns problem+json for an unmatched route", async () => {
    const app = setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});
