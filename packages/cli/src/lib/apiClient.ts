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

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** Minimal JSON REST client for the VeriCell API (`/api/v1`), shared by every CLI command. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl;
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

    const res = await fetch(joinUrl(this.baseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json: unknown = text.length > 0 ? JSON.parse(text) : undefined;

    if (!res.ok) {
      const problem = json as ProblemBody | undefined;
      throw new ApiRequestError(res.status, problem?.detail ?? problem?.title ?? res.statusText);
    }
    return json as T;
  }
}
