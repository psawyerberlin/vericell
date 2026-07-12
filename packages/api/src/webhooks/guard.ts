import { isIPv4, isIPv6 } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { ProblemError } from "../server/errors.js";

/**
 * SSRF guard for webhook URLs (ClaudeCodeInstruction.md Phase 6 / TECHNICAL.md
 * §9): denies any URL whose host resolves to a private, loopback, link-local
 * or otherwise non-routable address, so a caller can't point a webhook at the
 * API's own internal network. `WEBHOOK_ALLOW_PRIVATE_NETWORKS=1` is the
 * documented escape hatch for local testing (offckb devnet, this phase's own
 * test suite posting to a `127.0.0.1` receiver).
 */
export function truthyEnvFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function webhookPrivateNetworksAllowed(
  env: Record<string, string | undefined> | undefined = globalThis.process?.env,
): boolean {
  return truthyEnvFlag(env?.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
}

function ipv4ToInt(ip: string): number {
  return (
    ip
      .split(".")
      .map(Number)
      .reduce((acc, part) => (acc << 8) + part, 0) >>> 0
  );
}

// RFC 1918/5735-ish private, loopback, link-local, CGNAT, benchmark,
// multicast and reserved IPv4 ranges. Not exhaustive of every IANA special
// range, but covers everything a webhook receiver would plausibly resolve to
// on a private network or the host itself.
const IPV4_PRIVATE_RANGES: [base: string, prefixBits: number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateIpv4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  return IPV4_PRIVATE_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expands a (possibly `::`-compressed, possibly IPv4-tailed) IPv6 literal into 8 16-bit groups. */
function expandIpv6Groups(ip: string): number[] {
  let addr = ip;

  const v4TailMatch = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (v4TailMatch?.[1]) {
    const v4 = v4TailMatch[1].split(".").map(Number);
    const hex1 = ((v4[0]! << 8) | v4[1]!).toString(16);
    const hex2 = ((v4[2]! << 8) | v4[3]!).toString(16);
    addr = addr.slice(0, addr.length - v4TailMatch[1].length) + hex1 + ":" + hex2;
  }

  const parts = addr.split("::");
  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail];
  return groups.map((g) => parseInt(g, 16));
}

export function isPrivateIpv6(ip: string): boolean {
  const groups = expandIpv6Groups(ip.toLowerCase());
  // Unparseable input fails closed rather than being treated as public.
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return true;

  if (groups.every((g) => g === 0)) return true; // :: (unspecified)
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback

  const g0 = groups[0]!;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local

  // ::ffff:0:0/96 IPv4-mapped — defer to the embedded v4 address's own check.
  if (
    g0 === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const v4 = `${(groups[6]! >> 8) & 0xff}.${groups[6]! & 0xff}.${(groups[7]! >> 8) & 0xff}.${groups[7]! & 0xff}`;
    return isPrivateIpv4(v4);
  }

  return false;
}

/** Narrower than `dns.lookup`'s own overloaded signature — just the `{ all: true }` shape this guard needs. */
export type DnsLookupAllFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface AssertPublicUrlOptions {
  env?: Record<string, string | undefined>;
  lookupFn?: DnsLookupAllFn;
}

/**
 * Throws a 400 `ProblemError` if `urlString` isn't http(s), or its host
 * resolves (directly, or via DNS if it's a hostname) to a private/reserved
 * address — unless `WEBHOOK_ALLOW_PRIVATE_NETWORKS` is set. Called both at
 * registration time (fail fast) and again right before each delivery
 * attempt (defense in depth against DNS rebinding between registration and
 * delivery).
 */
export async function assertPublicWebhookUrl(
  urlString: string,
  opts: AssertPublicUrlOptions = {},
): Promise<void> {
  if (webhookPrivateNetworksAllowed(opts.env)) return;

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new ProblemError(400, "Bad Request", `"${urlString}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProblemError(400, "Bad Request", "Webhook URL must be http:// or https://");
  }

  const hostname = url.hostname;
  const lookupFn: DnsLookupAllFn = opts.lookupFn ?? ((h) => dnsLookup(h, { all: true }));

  let addresses: { address: string; family: number }[];
  if (isIPv4(hostname)) {
    addresses = [{ address: hostname, family: 4 }];
  } else if (isIPv6(hostname)) {
    addresses = [{ address: hostname, family: 6 }];
  } else {
    try {
      addresses = await lookupFn(hostname);
    } catch (err) {
      throw new ProblemError(
        400,
        "Bad Request",
        `Could not resolve webhook host "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const { address, family } of addresses) {
    const isPrivate = family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address);
    if (isPrivate) {
      throw new ProblemError(
        400,
        "Bad Request",
        `Webhook URL resolves to a private/reserved address (${address}) — set ` +
          "WEBHOOK_ALLOW_PRIVATE_NETWORKS=1 for local testing",
      );
    }
  }
}
