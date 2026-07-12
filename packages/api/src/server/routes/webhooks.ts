import { randomBytes, randomUUID } from "node:crypto";
import { assertPublicWebhookUrl } from "../../webhooks/guard.js";
import { requireApiKey } from "../auth.js";
import { NotFoundError } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { RegisterWebhookBodySchema, WebhookIdParams } from "../writeSchemas.js";
import type { TypedApp } from "../build.js";

/** Shown once at registration, like an API key — the receiver needs it forever to verify future HMAC signatures. */
function generateWebhookSecret(): string {
  return "whsec_" + randomBytes(32).toString("hex");
}

/**
 * `POST /api/v1/webhooks` / `DELETE /api/v1/webhooks/{id}` — TECHNICAL.md
 * §7.3. Both are bearer-key-scoped: registration ties the row to the
 * caller's `api_keys.key_hash`, and deletion only succeeds for the same key
 * that created it (ClaudeCodeInstruction.md Phase 6, "key-scoped").
 */
export function registerWebhookRoutes(app: TypedApp): void {
  app.post(
    "/api/v1/webhooks",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Register a webhook for committed/consumed/superseded events",
        body: RegisterWebhookBodySchema,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const { url, events, unid } = req.body;
        await assertPublicWebhookUrl(url);

        const id = randomUUID();
        const secret = generateWebhookSecret();

        app.db
          .prepare(
            `INSERT INTO webhooks (id, key_hash, unid, url, events, secret, created_at)
             VALUES (@id, @keyHash, @unid, @url, @events, @secret, @createdAt)`,
          )
          .run({
            id,
            keyHash: apiKeyHash,
            unid: unid ?? null,
            url,
            events: events.join(","),
            secret,
            createdAt: new Date().toISOString(),
          });

        return {
          status: 201,
          body: { id, url, events, unid: unid ?? null, secret },
        };
      });
    },
  );

  app.delete(
    "/api/v1/webhooks/:id",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Remove a webhook (only the API key that registered it may delete it)",
        params: WebhookIdParams,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const { id } = req.params;
        const row = app.db.prepare("SELECT key_hash FROM webhooks WHERE id = ?").get(id) as
          { key_hash: string } | undefined;
        // A webhook owned by a different key is indistinguishable from a
        // nonexistent one to this caller — no separate 403 that would leak
        // its existence.
        if (!row || row.key_hash !== apiKeyHash) {
          throw new NotFoundError(`No webhook with id "${id}"`);
        }

        app.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
        return { status: 200, body: { id, deleted: true } };
      });
    },
  );
}
