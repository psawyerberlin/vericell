import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { openDb } from "../db/open.js";
import { hashApiKey, perKeyRateLimitOptions } from "./auth.js";
import { buildServer } from "./build.js";

function fakeRequest(headers: Record<string, string> = {}, ip = "203.0.113.1"): FastifyRequest {
  return { headers, ip } as unknown as FastifyRequest;
}

describe("requireAdminToken", () => {
  it("500s on POST /keys when ADMIN_TOKEN isn't configured on the server", async () => {
    const db = openDb(":memory:");
    const app = buildServer({
      db,
      network: "devnet",
      adminToken: undefined,
      rateLimit: { max: 1000, timeWindow: "1 minute" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { authorization: "Bearer anything" },
      payload: {},
    });
    expect(res.statusCode).toBe(500);
  });
});

describe("perKeyRateLimitOptions", () => {
  const db = openDb(":memory:");
  const key = "vk_perkey_test";
  const keyHash = hashApiKey(key);
  db.prepare(
    "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
  ).run(keyHash, "test", new Date().toISOString(), 120);
  const { keyGenerator, max } = perKeyRateLimitOptions(db);

  it("keys by the hashed bearer token when present", () => {
    expect(keyGenerator(fakeRequest({ authorization: `Bearer ${key}` }))).toBe(keyHash);
  });

  it("falls back to the request IP when no bearer token is present", () => {
    expect(keyGenerator(fakeRequest({}, "198.51.100.7"))).toBe("198.51.100.7");
  });

  it("uses the key's own rate_limit when the token is recognized", () => {
    expect(max(fakeRequest({ authorization: `Bearer ${key}` }))).toBe(120);
  });

  it("defaults to 60 for a recognized-shaped but unknown key", () => {
    expect(max(fakeRequest({ authorization: "Bearer vk_not_in_db" }))).toBe(60);
  });

  it("caps unauthenticated requests at 5, tighter than any real per-key limit", () => {
    expect(max(fakeRequest({}))).toBe(5);
  });
});
