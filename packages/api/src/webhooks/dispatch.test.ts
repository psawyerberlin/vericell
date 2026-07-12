import { describe, expect, it } from "vitest";
import { openDb } from "../db/open.js";
import { enqueueWebhookDeliveries } from "./dispatch.js";
import type { WebhookEventPayload } from "./types.js";

function insertWebhook(
  db: ReturnType<typeof openDb>,
  opts: { id: string; unid: string | null; events: string },
): void {
  // webhooks.key_hash REFERENCES api_keys(key_hash) — seed the fixture key once.
  db.prepare(
    "INSERT OR IGNORE INTO api_keys (key_hash, label, created_at, rate_limit) VALUES ('key-hash', 'test', ?, 60)",
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT INTO webhooks (id, key_hash, unid, url, events, secret, created_at)
     VALUES (@id, 'key-hash', @unid, 'https://example.test/hook', @events, 'whsec_test', @createdAt)`,
  ).run({ ...opts, createdAt: new Date().toISOString() });
}

function payload(unid: string, txHash: string): WebhookEventPayload {
  return {
    event: "committed",
    unid,
    tx_hash: txHash,
    version_no: 1,
    project_sha256: "a".repeat(64),
    title: "Test Project",
    block_number: 10,
    block_time: new Date().toISOString(),
  };
}

describe("enqueueWebhookDeliveries", () => {
  it("enqueues for a webhook with unid = NULL regardless of the event's project", () => {
    const db = openDb(":memory:");
    insertWebhook(db, { id: "wh1", unid: null, events: "committed,consumed,superseded" });

    enqueueWebhookDeliveries(db, "committed", "project-a", payload("project-a", "0xabc"));

    const rows = db.prepare("SELECT * FROM webhook_deliveries").all() as { webhook_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.webhook_id).toBe("wh1");
    db.close();
  });

  it("only enqueues a project-scoped webhook for its own unid", () => {
    const db = openDb(":memory:");
    insertWebhook(db, { id: "wh-scoped", unid: "project-a", events: "committed" });

    enqueueWebhookDeliveries(db, "committed", "project-b", payload("project-b", "0xdef"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 0 });

    enqueueWebhookDeliveries(db, "committed", "project-a", payload("project-a", "0xabc"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 1 });
    db.close();
  });

  it("skips a webhook not subscribed to the fired event", () => {
    const db = openDb(":memory:");
    insertWebhook(db, { id: "wh-consumed-only", unid: null, events: "consumed" });

    enqueueWebhookDeliveries(db, "committed", "project-a", payload("project-a", "0xabc"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 0 });
    db.close();
  });

  it("stores the payload verbatim as JSON, pending, due immediately", () => {
    const db = openDb(":memory:");
    insertWebhook(db, { id: "wh1", unid: null, events: "committed" });

    const p = payload("project-a", "0xabc");
    enqueueWebhookDeliveries(db, "committed", "project-a", p);

    const row = db.prepare("SELECT * FROM webhook_deliveries").get() as {
      status: string;
      attempts: number;
      payload: string;
      next_attempt_at: string;
    };
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(JSON.parse(row.payload)).toEqual(p);
    expect(new Date(row.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
    db.close();
  });

  it("enqueues one delivery per matching webhook when several are registered", () => {
    const db = openDb(":memory:");
    insertWebhook(db, { id: "wh1", unid: null, events: "committed" });
    insertWebhook(db, { id: "wh2", unid: "project-a", events: "committed" });
    insertWebhook(db, { id: "wh3", unid: "project-b", events: "committed" });

    enqueueWebhookDeliveries(db, "committed", "project-a", payload("project-a", "0xabc"));

    const webhookIds = (
      db.prepare("SELECT webhook_id FROM webhook_deliveries").all() as { webhook_id: string }[]
    )
      .map((r) => r.webhook_id)
      .sort();
    expect(webhookIds).toEqual(["wh1", "wh2"]);
    db.close();
  });
});
