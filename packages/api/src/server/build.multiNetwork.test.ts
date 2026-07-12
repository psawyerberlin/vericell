import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "./auth.js";
import { openDb } from "../db/open.js";
import { buildServer, type TypedApp } from "./build.js";
import { FIXTURE, fakeFetchProof, fakeGetTip, seedFixtureDb } from "./testFixtures.js";

const ADMIN_TOKEN = "test-admin-token";

/**
 * Phase 10a: a single deployment serving both testnet and mainnet.
 * `testnetDb` is seeded with the standard 3-project fixture; `mainnetDb` is
 * deliberately left empty — an empty result set on the mainnet-prefixed
 * routes is the simplest possible proof that the two mounts never share a
 * database.
 */
function setupDualNetwork() {
  const testnetDb = openDb(":memory:");
  seedFixtureDb(testnetDb);
  const mainnetDb = openDb(":memory:");

  const app = buildServer({
    networks: {
      testnet: {
        db: testnetDb,
        fetchProof: fakeFetchProof(),
        getTip: fakeGetTip(120n),
        custodialEnabled: true,
      },
      mainnet: {
        db: mainnetDb,
        fetchProof: fakeFetchProof(),
        getTip: fakeGetTip(50n),
        custodialEnabled: false,
      },
    },
    defaultNetwork: "testnet",
    adminToken: ADMIN_TOKEN,
    rateLimit: { max: 1000, timeWindow: "1 minute" },
  });

  return { app, testnetDb, mainnetDb };
}

describe("dual-network route mounting (Phase 10a)", () => {
  let app: TypedApp;
  let testnetDb: ReturnType<typeof openDb>;
  let mainnetDb: ReturnType<typeof openDb>;

  beforeEach(() => {
    ({ app, testnetDb, mainnetDb } = setupDualNetwork());
  });

  it("mounts each network at its own prefix, bound to its own DB", async () => {
    const testnetRes = await app.inject({ method: "GET", url: "/api/v1/testnet/projects" });
    const mainnetRes = await app.inject({ method: "GET", url: "/api/v1/mainnet/projects" });

    expect(testnetRes.statusCode).toBe(200);
    expect(mainnetRes.statusCode).toBe(200);
    expect(testnetRes.json().total).toBe(3);
    expect(mainnetRes.json().total).toBe(0);
  });

  it("a project indexed on testnet 404s on the mainnet-prefixed tree", async () => {
    const onTestnet = await app.inject({
      method: "GET",
      url: `/api/v1/testnet/projects/${FIXTURE.alpha.unid}`,
    });
    const onMainnet = await app.inject({
      method: "GET",
      url: `/api/v1/mainnet/projects/${FIXTURE.alpha.unid}`,
    });

    expect(onTestnet.statusCode).toBe(200);
    expect(onMainnet.statusCode).toBe(404);
  });

  it("aliases the bare /api/v1/... root to the default network", async () => {
    const aliasRes = await app.inject({ method: "GET", url: "/api/v1/projects" });
    const testnetRes = await app.inject({ method: "GET", url: "/api/v1/testnet/projects" });

    expect(aliasRes.statusCode).toBe(200);
    expect(aliasRes.json()).toEqual(testnetRes.json());
  });

  it("/stats on a network-prefixed mount reports only that one network, with no `networks` breakdown", async () => {
    const testnetStats = (await app.inject({ method: "GET", url: "/api/v1/testnet/stats" })).json();
    const mainnetStats = (await app.inject({ method: "GET", url: "/api/v1/mainnet/stats" })).json();

    expect(testnetStats.network).toBe("testnet");
    expect(testnetStats.projects).toBe(3);
    expect(testnetStats.networks).toBeUndefined();

    expect(mainnetStats.network).toBe("mainnet");
    expect(mainnetStats.projects).toBe(0);
    expect(mainnetStats.networks).toBeUndefined();
  });

  it("the aliased /stats and /health show every mounted network", async () => {
    const stats = (await app.inject({ method: "GET", url: "/api/v1/stats" })).json();
    expect(stats.network).toBe("testnet");
    expect(stats.projects).toBe(3);
    expect(stats.networks.testnet.projects).toBe(3);
    expect(stats.networks.mainnet.projects).toBe(0);

    const health = (await app.inject({ method: "GET", url: "/api/v1/health" })).json();
    expect(health.network).toBe("testnet");
    expect(health.networks.testnet.indexer.tip).toBe(120);
    expect(health.networks.mainnet.indexer.tip).toBe(50);
  });

  it("an API key minted on one network's /keys is stored only in that network's own DB", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/testnet/keys",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: "testnet-only" },
    });
    expect(res.statusCode).toBe(201);
    const keyHash = res.json().key_hash as string;

    expect(
      testnetDb.prepare("SELECT 1 FROM api_keys WHERE key_hash = ?").get(keyHash),
    ).toBeDefined();
    expect(
      mainnetDb.prepare("SELECT 1 FROM api_keys WHERE key_hash = ?").get(keyHash),
    ).toBeUndefined();
  });

  it("a key valid on testnet is not recognized on mainnet's /proofs* routes (separate api_keys tables)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/testnet/keys",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: "testnet-only" },
    });
    const key = created.json().key as string;

    const onMainnet = await app.inject({
      method: "POST",
      url: "/api/v1/mainnet/proofs",
      headers: { authorization: `Bearer ${key}` },
      payload: {
        manifest: {
          title: "x",
          declared_author: "someone",
          files: [{ p: "a.txt", h: "a".repeat(64) }],
        },
      },
    });
    expect(onMainnet.statusCode).toBe(401);
  });

  it("each network's custodial-mode gate is independent (mainnet's is off, testnet's is on)", async () => {
    // Same key hash inserted directly into both DBs, so this test isolates
    // the custodial-mode gate itself from the (separately tested) api-key
    // isolation above.
    const key = "vk_" + "a".repeat(64);
    const keyHash = hashApiKey(key);
    for (const db of [testnetDb, mainnetDb]) {
      db.prepare(
        "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
      ).run(keyHash, "shared-fixture", new Date().toISOString(), 1000);
    }

    const payload = {
      manifest: {
        title: "x",
        declared_author: "someone",
        files: [{ p: "a.txt", h: "a".repeat(64) }],
      },
    };

    const onMainnet = await app.inject({
      method: "POST",
      url: "/api/v1/mainnet/proofs",
      headers: { authorization: `Bearer ${key}` },
      payload,
    });
    expect(onMainnet.statusCode).toBe(403);
    expect(onMainnet.json().detail).toMatch(/Custodial mode is disabled/);

    const onTestnet = await app.inject({
      method: "POST",
      url: "/api/v1/testnet/proofs",
      headers: { authorization: `Bearer ${key}` },
      payload,
    });
    // custodialEnabled: true on testnet clears the disabled-mode gate
    // entirely — it fails later for unrelated reasons (no real chain/signer
    // wired up in this unit test), but never with "Custodial mode is
    // disabled", which is the one thing this test is proving.
    expect(onTestnet.statusCode).not.toBe(403);
  });

  it("OpenAPI documents the network path via a templated server variable", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const body = res.json();

    const templated = body.servers.find((s: { url: string }) => s.url === "/api/v1/{network}");
    expect(templated).toBeDefined();
    expect(templated.variables.network.enum.sort()).toEqual(["mainnet", "testnet"]);
    expect(templated.variables.network.default).toBe("testnet");

    expect(body.paths["/testnet/projects"]).toBeDefined();
    expect(body.paths["/mainnet/projects"]).toBeDefined();
    expect(body.paths["/projects"]).toBeDefined();
  });
});
