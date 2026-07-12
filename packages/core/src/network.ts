export type Network = "devnet" | "testnet" | "mainnet";

const VALID_NETWORKS: readonly Network[] = ["devnet", "testnet", "mainnet"];

function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && (VALID_NETWORKS as readonly string[]).includes(value);
}

/**
 * Reads VERICELL_NETWORK (Node/API/CLI) or VITE_VERICELL_NETWORK (web, baked
 * at build time). The Vite access is written as one direct, un-aliased
 * `import.meta.env.KEY` expression deliberately: Vite only statically
 * replaces (and thus tree-shakes/inlines) `import.meta.env` accessed as a
 * single literal chain in production builds — assigning `import.meta` (or
 * `import.meta.env`) to an intermediate variable first breaks that static
 * match, silently leaving `import.meta.env` as the *real*, unpolyfilled
 * runtime value (`undefined` in a shipped browser bundle) instead of the
 * inlined build-time string. Confirmed empirically against a real `vite
 * build` — see docs/DECISIONS.md.
 */
function resolveNetwork(): Network {
  const fromProcessEnv: unknown = globalThis.process?.env?.VERICELL_NETWORK;
  if (isNetwork(fromProcessEnv)) return fromProcessEnv;

  const fromViteEnv: unknown = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env?.VITE_VERICELL_NETWORK;
  if (isNetwork(fromViteEnv)) return fromViteEnv;

  return "testnet";
}

/** Single source of truth for the active chain. Every package imports this — no other package may hardcode a network. */
export const NETWORK: Network = resolveNetwork();

const EXPLORER_URLS: Record<Network, string> = {
  devnet: "http://localhost:8114-local",
  testnet: "https://testnet.explorer.nervos.org",
  mainnet: "https://explorer.nervos.org",
};

export const EXPLORER_URL: string = EXPLORER_URLS[NETWORK];

export function isMainnet(): boolean {
  return NETWORK === "mainnet";
}

/**
 * Explorer URL for an arbitrary network, not just the build-time `NETWORK`.
 * For runtime consumers (e.g. the web app's network toggle, phase 10b) that
 * need to resolve links for a network the user switched to at runtime —
 * `EXPLORER_URL` alone only ever reflects the build-time default.
 */
export function explorerUrlForNetwork(network: Network): string {
  return EXPLORER_URLS[network];
}
