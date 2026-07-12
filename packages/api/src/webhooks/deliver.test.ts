/**
 * Phase 6 acceptance: a local HTTP receiver asserts the delivered payload
 * and a valid HMAC signature on a `committed` and a `superseded` event
 * (ClaudeCodeInstruction.md Phase 6), plus a retry test against a
 * deliberately flaky receiver. The receiver runs on `127.0.0.1`, which the
 * SSRF guard denies by default — `WEBHOOK_ALLOW_PRIVATE_NETWORKS=1` is set
 * for the duration of this suite, exactly the "env escape hatch for local
 * testing" the guard documents.
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db/open.js";
import { Indexer } from "../indexer/indexer.js";
import { FakeChainClient } from "../indexer/fakeChainClient.js";
import { anchorTx, manifestBytesFor } from "../indexer/testFixtures.js";
import { deliverPendingWebhooks } from "./deliver.js";

interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Receiver {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

function startReceiver(
  respond: (req: CapturedRequest, n: number) => number,
  extraHeaders?: (n: number) => Record<string, string>,
): Promise<Receiver> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const captured: CapturedRequest = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        requests.push(captured);
        const status = respond(captured, requests.length);
        res.writeHead(status, {
          "content-type": "application/json",
          ...extraHeaders?.(requests.length),
        });
        res.end(JSON.stringify({ received: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, requests, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function verifySignature(secret: string, body: string, header: unknown): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return header === `sha256=${expected}`;
}

// webhooks.key_hash REFERENCES api_keys(key_hash) — seed the fixture key once per db.
function seedApiKey(db: ReturnType<typeof openDb>): void {
  db.prepare(
    "INSERT OR IGNORE INTO api_keys (key_hash, label, created_at, rate_limit) VALUES ('key-hash', 'test', ?, 60)",
  ).run(new Date().toISOString());
}

const ORIGINAL_ESCAPE_HATCH = globalThis.process?.env?.WEBHOOK_ALLOW_PRIVATE_NETWORKS;

beforeEach(() => {
  // The local receiver lives on 127.0.0.1 — allow it past the SSRF guard,
  // same escape hatch documented for local testing.
  globalThis.process!.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "1";
});

afterEach(() => {
  if (ORIGINAL_ESCAPE_HATCH === undefined) {
    delete globalThis.process!.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
  } else {
    globalThis.process!.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = ORIGINAL_ESCAPE_HATCH;
  }
});

describe("webhook delivery against a local HTTP receiver", () => {
  it("delivers a committed event and, on a later poll, a superseded event — both with a valid HMAC", async () => {
    const receiver = await startReceiver(() => 200);
    const secret = "whsec_test_secret_12345";

    const db = openDb(":memory:");
    seedApiKey(db);
    db.prepare(
      `INSERT INTO webhooks (id, key_hash, unid, url, events, secret, created_at)
       VALUES ('wh1', 'key-hash', NULL, ?, 'committed,consumed,superseded', ?, ?)`,
    ).run(`http://127.0.0.1:${receiver.port}/hook`, secret, new Date().toISOString());

    const client = new FakeChainClient();
    const indexer = new Indexer({ db, client, startBlock: 0n });

    const txA = anchorTx(await manifestBytesFor("Webhook Project"));
    client.addBlock([txA]);
    const txAHash = txA.hash();

    await indexer.pollOnce();

    expect(receiver.requests).toHaveLength(1);
    const committedReq = receiver.requests[0]!;
    const committedBody = JSON.parse(committedReq.body) as {
      event: string;
      tx_hash: string;
      unid: string;
    };
    expect(committedBody.event).toBe("committed");
    expect(committedBody.tx_hash).toBe(txAHash);
    expect(
      verifySignature(secret, committedReq.body, committedReq.headers["x-vericell-signature"]),
    ).toBe(true);

    const committedDelivery = db
      .prepare("SELECT status FROM webhook_deliveries WHERE event = 'committed'")
      .get() as { status: string };
    expect(committedDelivery.status).toBe("delivered");

    // Second version supersedes the first in the same tx that consumes it.
    const txB = anchorTx(
      await manifestBytesFor("Webhook Project v2", { genesis: txAHash, prev: txAHash }),
      {
        txHash: txAHash,
        index: 0,
      },
    );
    client.addBlock([txB]);
    const txBHash = txB.hash();

    await indexer.pollOnce();

    // + committed(v2), consumed(v1), superseded(project) — 3 new deliveries on top of the first.
    expect(receiver.requests).toHaveLength(4);

    const events = receiver.requests
      .slice(1)
      .map((r) => (JSON.parse(r.body) as { event: string }).event)
      .sort();
    expect(events).toEqual(["committed", "consumed", "superseded"]);

    const supersededReq = receiver.requests.find(
      (r) => (JSON.parse(r.body) as { event: string }).event === "superseded",
    )!;
    const supersededBody = JSON.parse(supersededReq.body) as {
      event: string;
      tx_hash: string;
      successor_tx_hash: string;
      unid: string;
    };
    expect(supersededBody.tx_hash).toBe(txAHash);
    expect(supersededBody.successor_tx_hash).toBe(txBHash);
    expect(
      verifySignature(secret, supersededReq.body, supersededReq.headers["x-vericell-signature"]),
    ).toBe(true);

    const deliveryStatuses = db.prepare("SELECT status FROM webhook_deliveries").all() as {
      status: string;
    }[];
    expect(deliveryStatuses.every((d) => d.status === "delivered")).toBe(true);

    db.close();
    await receiver.close();
  });

  it("retries against a flaky receiver, then succeeds — attempts and log observability", async () => {
    const receiver = await startReceiver((_req, n) => (n < 2 ? 500 : 200));
    const secret = "whsec_flaky_secret";

    const db = openDb(":memory:");
    seedApiKey(db);
    db.prepare(
      `INSERT INTO webhooks (id, key_hash, unid, url, events, secret, created_at)
       VALUES ('wh-flaky', 'key-hash', NULL, ?, 'committed', ?, ?)`,
    ).run(`http://127.0.0.1:${receiver.port}/hook`, secret, new Date().toISOString());

    // next_attempt_at/created_at are seeded on the *fake* clock's own
    // timeline (defined next), not the real wall clock — deliverPendingWebhooks
    // compares next_attempt_at against the injected `now`, and a real
    // timestamp here would only coincidentally be <= a fixed-in-the-past fake `now`.
    const t0 = new Date("2026-01-01T00:00:00Z");
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, unid, tx_hash, payload, status, attempts, next_attempt_at, created_at)
       VALUES ('d1', 'wh-flaky', 'committed', 'p1', '0xabc', '{"event":"committed"}', 'pending', 0, ?, ?)`,
    ).run(t0.toISOString(), t0.toISOString());

    const warnings: { obj: unknown; msg?: string }[] = [];
    const logger = {
      info() {},
      warn: (obj: unknown, msg?: string) => warnings.push({ obj, msg }),
      error() {},
    };

    // Attempt 1: receiver 500s.
    await deliverPendingWebhooks({ db, logger, now: () => t0 });
    expect(receiver.requests).toHaveLength(1);
    let row = db
      .prepare("SELECT status, attempts FROM webhook_deliveries WHERE id = 'd1'")
      .get() as {
      status: string;
      attempts: number;
    };
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toMatch(/will retry/);

    // Too soon — the backoff window hasn't elapsed yet (fake clock barely moved).
    await deliverPendingWebhooks({ db, logger, now: () => new Date(t0.getTime() + 10) });
    expect(receiver.requests).toHaveLength(1);

    // Attempt 2, past the backoff window: receiver now succeeds.
    await deliverPendingWebhooks({ db, logger, now: () => new Date(t0.getTime() + 5000) });
    expect(receiver.requests).toHaveLength(2);
    row = db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE id = 'd1'").get() as {
      status: string;
      attempts: number;
    };
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1); // attempts field isn't touched on the success branch

    db.close();
    await receiver.close();
  });

  it("dead-letters after maxAttempts against a receiver that never recovers", async () => {
    const receiver = await startReceiver(() => 500);
    const secret = "whsec_dead_secret";

    const db = openDb(":memory:");
    seedApiKey(db);
    db.prepare(
      `INSERT INTO webhooks (id, key_hash, unid, url, events, secret, created_at)
       VALUES ('wh-dead', 'key-hash', NULL, ?, 'committed', ?, ?)`,
    ).run(`http://127.0.0.1:${receiver.port}/hook`, secret, new Date().toISOString());

    // Seeded on the fake clock's timeline — see the identical comment in the flaky-receiver test above.
    let now = new Date("2026-01-01T00:00:00Z");
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, unid, tx_hash, payload, status, attempts, next_attempt_at, created_at)
       VALUES ('d-dead', 'wh-dead', 'committed', 'p1', '0xabc', '{"event":"committed"}', 'pending', 0, ?, ?)`,
    ).run(now.toISOString(), now.toISOString());

    const warnings: { obj: unknown; msg?: string }[] = [];
    const logger = {
      info() {},
      warn: (obj: unknown, msg?: string) => warnings.push({ obj, msg }),
      error() {},
    };
    const maxAttempts = 3;

    for (let i = 0; i < maxAttempts; i++) {
      await deliverPendingWebhooks({ db, logger, now: () => now, maxAttempts });
      now = new Date(now.getTime() + 10 * 60_000); // well past any backoff window
    }

    expect(receiver.requests).toHaveLength(maxAttempts);
    const row = db
      .prepare("SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = 'd-dead'")
      .get() as {
      status: string;
      attempts: number;
      last_error: string;
    };
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(maxAttempts);
    expect(row.last_error).toMatch(/500/);
    expect(warnings).toHaveLength(maxAttempts);
    expect(warnings.at(-1)?.msg).toMatch(/dead-lettered/);

    db.close();
    await receiver.close();
  });

  it("does not follow a redirect response (SSRF-via-redirect guard)", async () => {
    // The redirect target is never actually requested — a receiver's own
    // internal-network address would otherwise bypass the URL-registration-
    // time SSRF check entirely, since `fetch` follows redirects by default.
    const receiver = await startReceiver(
      () => 302,
      () => ({ location: "http://127.0.0.1:1/internal" }),
    );
    const secret = "whsec_redirect_secret";

    const db = openDb(":memory:");
    seedApiKey(db);
    db.prepare(
      `INSERT INTO webhooks (id, key_hash, unid, url, events, secret, created_at)
       VALUES ('wh-redirect', 'key-hash', NULL, ?, 'committed', ?, ?)`,
    ).run(`http://127.0.0.1:${receiver.port}/hook`, secret, new Date().toISOString());

    const t0 = new Date("2026-01-01T00:00:00Z");
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, unid, tx_hash, payload, status, attempts, next_attempt_at, created_at)
       VALUES ('d-redirect', 'wh-redirect', 'committed', 'p1', '0xabc', '{"event":"committed"}', 'pending', 0, ?, ?)`,
    ).run(t0.toISOString(), t0.toISOString());

    const warnings: { obj: unknown; msg?: string }[] = [];
    const logger = {
      info() {},
      warn: (obj: unknown, msg?: string) => warnings.push({ obj, msg }),
      error() {},
    };

    await deliverPendingWebhooks({ db, logger, now: () => t0 });

    expect(receiver.requests).toHaveLength(1);
    const row = db
      .prepare("SELECT status, last_error FROM webhook_deliveries WHERE id = 'd-redirect'")
      .get() as { status: string; last_error: string };
    expect(row.status).toBe("pending");
    expect(row.last_error).toMatch(/redirect/i);

    db.close();
    await receiver.close();
  });
});
