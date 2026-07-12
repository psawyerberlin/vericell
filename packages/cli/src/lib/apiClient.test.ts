import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiRequestError, normalizeApiBaseUrl } from "./apiClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeApiBaseUrl", () => {
  it("appends /api/v1 to a bare origin", () => {
    expect(normalizeApiBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/api/v1");
  });

  it("appends /api/v1 to a bare origin with a trailing slash", () => {
    expect(normalizeApiBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000/api/v1");
  });

  it("leaves a full base URL unchanged", () => {
    expect(normalizeApiBaseUrl("http://localhost:3000/api/v1")).toBe(
      "http://localhost:3000/api/v1",
    );
  });

  it("strips a trailing slash from a full base URL", () => {
    expect(normalizeApiBaseUrl("http://localhost:3000/api/v1/")).toBe(
      "http://localhost:3000/api/v1",
    );
  });

  it("is case-insensitive when checking for an existing prefix", () => {
    expect(normalizeApiBaseUrl("http://localhost:3000/API/V1")).toBe(
      "http://localhost:3000/API/V1",
    );
  });
});

describe("ApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET sends no body and no authorization header without an apiKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1" });
    const result = await client.get<{ ok: boolean }>("/stats");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      NonNullable<Parameters<typeof fetch>[1]>,
    ];
    expect(url).toBe("http://api.test/api/v1/stats");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("joins baseUrl and path without a double slash, trimming a trailing slash on baseUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1/" });
    await client.get("/stats");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/api/v1/stats");
  });

  it("accepts a bare origin for --api, auto-appending /api/v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://localhost:3000" });
    await client.get("/stats");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/v1/stats");
  });

  it("POST sends a JSON body and a bearer authorization header when apiKey is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { tx_hash: "0xabc" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", apiKey: "vk_test" });
    const result = await client.post<{ tx_hash: string }>("/proofs/submit", { tx: { a: 1 } });

    expect(result.tx_hash).toBe("0xabc");
    const [, init] = fetchMock.mock.calls[0] as [string, NonNullable<Parameters<typeof fetch>[1]>];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ tx: { a: 1 } }));
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer vk_test");
  });

  it("DELETE issues a DELETE request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { deleted: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", apiKey: "vk_test" });
    await client.delete("/proofs/unid1");

    expect((fetchMock.mock.calls[0]?.[1] as NonNullable<Parameters<typeof fetch>[1]>).method).toBe(
      "DELETE",
    );
  });

  it("throws ApiRequestError with the problem+json detail on a non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(404, { title: "Not Found", detail: 'No project with unid "x"' }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1" });
    await expect(client.get("/projects/x")).rejects.toThrow(ApiRequestError);
    await expect(client.get("/projects/x")).rejects.toThrow(/No project with unid/);
  });

  it("wraps a network-level fetch failure with a hint to check --api", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://localhost:9" });
    await expect(client.get("/stats")).rejects.toThrow(ApiRequestError);
    await expect(client.get("/stats")).rejects.toThrow(/check --api is correct/);
  });

  it("wraps a non-JSON response body with a hint that --api's path prefix may be wrong", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("<html>not the API</html>", { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchMock);

    // A bare origin missing /api/v1 is exactly the shape of mistake this
    // guards against — e.g. pointed at a web app instead of the API.
    const client = new ApiClient({ baseUrl: "http://localhost:5173" });
    await expect(client.get("/stats")).rejects.toThrow(ApiRequestError);
    await expect(client.get("/stats")).rejects.toThrow(/not valid JSON/);
    await expect(client.get("/stats")).rejects.toThrow(/api\/v1/);
  });

  it("falls back to the response's title, then statusText, when no detail is present", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { title: "Internal Server Error" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1" });
    await expect(client.get("/stats")).rejects.toThrow("Internal Server Error");
  });

  it("handles an empty response body (e.g. a 204) without throwing on JSON.parse", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1" });
    await expect(client.get("/health")).resolves.toBeUndefined();
  });

  it("records the HTTP status on ApiRequestError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { title: "Unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "http://api.test/api/v1" });
    try {
      await client.get("/proofs/prepare");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect((err as ApiRequestError).status).toBe(401);
    }
  });
});
