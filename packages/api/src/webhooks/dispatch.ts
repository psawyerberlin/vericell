import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { WebhookEvent, WebhookEventPayload } from "./types.js";

interface WebhookRow {
  id: string;
  events: string;
}

/**
 * Enqueues one `webhook_deliveries` row per registered webhook matching this
 * event: `unid IS NULL` webhooks watch every project, `unid = @unid` ones
 * watch only that one (TECHNICAL.md §6's own comment on the column). Called
 * from `indexer/process.ts` inside the same `db.transaction()` as the
 * project/version write that triggered it, so a delivery is never queued for
 * a state change that itself gets rolled back.
 */
export function enqueueWebhookDeliveries(
  db: Database.Database,
  event: WebhookEvent,
  unid: string,
  payload: WebhookEventPayload,
): void {
  const webhooks = db
    .prepare("SELECT id, events FROM webhooks WHERE unid IS NULL OR unid = ?")
    .all(unid) as WebhookRow[];
  if (webhooks.length === 0) return;

  const now = new Date().toISOString();
  const body = JSON.stringify(payload);
  const insert = db.prepare(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event, unid, tx_hash, payload, status, attempts, next_attempt_at, created_at)
     VALUES (@id, @webhookId, @event, @unid, @txHash, @payload, 'pending', 0, @nextAttemptAt, @createdAt)`,
  );

  for (const webhook of webhooks) {
    if (!webhook.events.split(",").includes(event)) continue;
    insert.run({
      id: randomUUID(),
      webhookId: webhook.id,
      event,
      unid,
      txHash: payload.tx_hash,
      payload: body,
      nextAttemptAt: now,
      createdAt: now,
    });
  }
}
