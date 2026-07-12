import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { assertPublicWebhookUrl } from "./guard.js";

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** `1s, 2s, 4s, 8s, ...` capped at 5 minutes — `attempts` is the attempt number that just failed (1-indexed). */
function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

/** `X-VeriCell-Signature: sha256=<hex hmac>` over the exact bytes sent as the body (TECHNICAL.md §7.3). */
export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export interface DeliverPendingWebhooksOptions {
  db: Database.Database;
  /** Defaults to the global `fetch` — injectable so tests can point at a local receiver or simulate flakiness. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Defaults to `Date.now`-backed wall clock — injectable so retry-backoff tests never need to sleep for real. */
  now?: () => Date;
  /** Total delivery attempts (including the first) before dead-lettering. */
  maxAttempts?: number;
  /** Forwarded to the SSRF guard's env lookup — lets tests exercise the escape hatch without mutating `process.env`. */
  guardEnv?: Record<string, string | undefined>;
}

interface DueDeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  attempts: number;
  url: string;
  secret: string;
}

/**
 * Delivers every due `webhook_deliveries` row (`status = 'pending' AND
 * next_attempt_at <= now`): POSTs the stored payload with a signed HMAC
 * header, marks it `delivered` on a 2xx response, or schedules an
 * exponential-backoff retry (re-checking the SSRF guard each time, in case
 * DNS now resolves the host differently) up to `maxAttempts`, after which it
 * is `dead`-lettered. Called from the indexer's poll loop
 * (`indexer/indexer.ts`) — see ClaudeCodeInstruction.md Phase 6.
 */
export async function deliverPendingWebhooks(opts: DeliverPendingWebhooksOptions): Promise<void> {
  const {
    db,
    fetchImpl = fetch,
    logger = NOOP_LOGGER,
    now = () => new Date(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    guardEnv,
  } = opts;

  const nowIso = now().toISOString();
  const due = db
    .prepare(
      `SELECT d.id, d.webhook_id, d.event, d.payload, d.attempts, w.url, w.secret
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= ?
       ORDER BY d.created_at ASC`,
    )
    .all(nowIso) as DueDeliveryRow[];

  for (const row of due) {
    await attemptDelivery(db, row, { fetchImpl, logger, now, maxAttempts, guardEnv });
  }
}

async function attemptDelivery(
  db: Database.Database,
  row: DueDeliveryRow,
  opts: {
    fetchImpl: typeof fetch;
    logger: Logger;
    now: () => Date;
    maxAttempts: number;
    guardEnv?: Record<string, string | undefined>;
  },
): Promise<void> {
  try {
    await assertPublicWebhookUrl(row.url, { env: opts.guardEnv });

    const signature = signPayload(row.secret, row.payload);
    const res = await opts.fetchImpl(row.url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-VeriCell-Signature": signature },
      body: row.payload,
      // The SSRF guard above only validates row.url's own host; a receiver
      // that 30x-redirects the delivery could otherwise point the actual
      // request at a private address without ever registering one. `fetch`
      // follows redirects by default, so a 3xx here is treated as a failed
      // delivery rather than transparently followed — a receiver that
      // legitimately moved must be re-registered at its new URL.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`receiver responded with a redirect (HTTP ${res.status}), not followed`);
    }
    if (!res.ok) {
      throw new Error(`receiver responded with HTTP ${res.status}`);
    }

    db.prepare("UPDATE webhook_deliveries SET status = 'delivered' WHERE id = ?").run(row.id);
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);

    if (attempts >= opts.maxAttempts) {
      db.prepare(
        "UPDATE webhook_deliveries SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?",
      ).run(attempts, message, row.id);
      opts.logger.warn(
        {
          deliveryId: row.id,
          webhookId: row.webhook_id,
          event: row.event,
          attempts,
          err: message,
        },
        "webhook delivery dead-lettered after max attempts",
      );
      return;
    }

    const nextAttemptAt = new Date(opts.now().getTime() + backoffMs(attempts)).toISOString();
    db.prepare(
      "UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
    ).run(attempts, nextAttemptAt, message, row.id);
    opts.logger.warn(
      {
        deliveryId: row.id,
        webhookId: row.webhook_id,
        event: row.event,
        attempts,
        nextAttemptAt,
        err: message,
      },
      "webhook delivery failed, will retry",
    );
  }
}
