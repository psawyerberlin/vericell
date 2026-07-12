import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../db/open.js";
import { hashApiKey } from "../auth.js";
import { buildServer, type TypedApp } from "../build.js";

const API_KEY = "vk_webhooks_test_0123456789abcdef";
const API_KEY_HASH = hashApiKey(API_KEY);
const OTHER_API_KEY = "vk_other_key_0123456789abcdef0000";
const AUTH = { authorization: `Bearer ${API_KEY}` };
const OTHER_AUTH = { authorization: `Bearer ${OTHER_API_KEY}` };

function setup(): TypedApp {
  const db = openDb(":memory:");
  const insert = db.prepare(
    "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
  );
  insert.run(API_KEY_HASH, "test", new Date().toISOString(), 1000);
  insert.run(hashApiKey(OTHER_API_KEY), "other", new Date().toISOString(), 1000);

  return buildServer({
    db,
    network: "devnet",
    rateLimit: { max: 1000, timeWindow: "1 minute" },
  });
}

const ORIGINAL_ESCAPE_HATCH = globalThis.process?.env?.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
beforeEach(() => {
  // Route tests register webhooks pointed at made-up https:// hostnames that
  // are never actually resolved/dialed in these tests, but a couple of
  // negative cases use a loopback URL on purpose — the escape hatch keeps
  // registration tests independent of real DNS.
  globalThis.process!.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "1";
});
afterEach(() => {
  if (ORIGINAL_ESCAPE_HATCH === undefined) {
    delete globalThis.process!.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
  } else {
    globalThis.process!.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = ORIGINAL_ESCAPE_HATCH;
  }
});

describe("POST /api/v1/webhooks", () => {
  let app: TypedApp;
  beforeEach(() => {
    app = setup();
  });

  it("401s without a bearer key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: { url: "https://example.test/hook", events: ["committed"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("registers a webhook and returns the secret once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: AUTH,
      payload: { url: "https://example.test/hook", events: ["committed", "superseded"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.url).toBe("https://example.test/hook");
    expect(body.events).toEqual(["committed", "superseded"]);
    expect(body.unid).toBeNull();
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const row = app.db
      .prepare("SELECT key_hash, url, events, secret FROM webhooks WHERE id = ?")
      .get(body.id) as { key_hash: string; url: string; events: string; secret: string };
    expect(row.key_hash).toBe(API_KEY_HASH);
    expect(row.events).toBe("committed,superseded");
    expect(row.secret).toBe(body.secret);
  });

  it("accepts an optional unid to scope the webhook to one project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: AUTH,
      payload: { url: "https://example.test/hook", events: ["committed"], unid: "project-a" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().unid).toBe("project-a");
  });

  it("400s on an invalid events value", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: AUTH,
      payload: { url: "https://example.test/hook", events: ["not-a-real-event"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on a malformed URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: AUTH,
      payload: { url: "not-a-url", events: ["committed"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s (SSRF guard) on a private-network URL when the escape hatch is off", async () => {
    delete globalThis.process!.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: AUTH,
      payload: { url: "http://127.0.0.1:9999/hook", events: ["committed"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Idempotency-Key replay returns the same webhook, not a second registration", async () => {
    const headers = { ...AUTH, "idempotency-key": "wh-replay-1" };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers,
      payload: { url: "https://example.test/hook", events: ["committed"] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers,
      payload: { url: "https://example.test/hook", events: ["committed"] },
    });
    expect(second.json()).toEqual(first.json());

    const count = (app.db.prepare("SELECT COUNT(*) AS n FROM webhooks").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe("DELETE /api/v1/webhooks/:id", () => {
  let app: TypedApp;
  let webhookId: string;

  beforeEach(async () => {
    app = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: AUTH,
      payload: { url: "https://example.test/hook", events: ["committed"] },
    });
    webhookId = res.json().id;
  });

  it("401s without a bearer key", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/v1/webhooks/${webhookId}` });
    expect(res.statusCode).toBe(401);
  });

  it("removes a webhook owned by the calling key", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/webhooks/${webhookId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: webhookId, deleted: true });

    const row = app.db.prepare("SELECT id FROM webhooks WHERE id = ?").get(webhookId);
    expect(row).toBeUndefined();
  });

  it("404s deleting a webhook owned by a different key (key-scoped)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/webhooks/${webhookId}`,
      headers: OTHER_AUTH,
    });
    expect(res.statusCode).toBe(404);

    const row = app.db.prepare("SELECT id FROM webhooks WHERE id = ?").get(webhookId);
    expect(row).toBeDefined();
  });

  it("404s deleting an unknown webhook id", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/webhooks/does-not-exist",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});
