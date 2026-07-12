/** Thrown for any non-2xx response; carries the RFC 9457 problem+json detail when present. */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string;
}

interface ProblemBody {
  title?: string;
  detail?: string;
}

const API_PATH_PREFIX = "/api/v1";

/**
 * `--api` accepts either a bare origin (`http://host:3000`) or the full base
 * URL including the version prefix (`http://host:3000/api/v1`) — the prefix
 * is appended automatically when it's missing, so both forms work the same
 * way in the automation flow (TECHNICAL.md §7.5) without the caller having
 * to know or remember the exact mount path.
 */
export function normalizeApiBaseUrl(input: string): string {
  const trimmed = input.replace(/\/+$/, "");
  return trimmed.toLowerCase().endsWith(API_PATH_PREFIX) ? trimmed : `${trimmed}${API_PATH_PREFIX}`;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** Minimal JSON REST client for the VeriCell API (`/api/v1`), shared by every CLI command. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = normalizeApiBaseUrl(opts.baseUrl);
    this.apiKey = opts.apiKey;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const url = joinUrl(this.baseUrl, path);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiRequestError(
        0,
        `Could not reach "${url}": ${err instanceof Error ? err.message : String(err)} — ` +
          `check --api is correct and the server is running`,
      );
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiRequestError(
        res.status,
        `Response from "${url}" was not valid JSON (HTTP ${res.status}) — ` +
          `--api usually needs to point at the API's base URL, e.g. http://host:port${API_PATH_PREFIX} ` +
          `(a bare origin has ${API_PATH_PREFIX} appended automatically, but a reverse proxy or the ` +
          `wrong host/port can still route elsewhere)`,
      );
    }

    if (!res.ok) {
      const problem = json as ProblemBody | undefined;
      throw new ApiRequestError(res.status, problem?.detail ?? problem?.title ?? res.statusText);
    }
    return json as T;
  }
}
