import { z } from "zod";

const HEX_64 = /^[0-9a-f]{64}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;

export const ManifestFileSchema = z.object({
  p: z.string().min(1),
  h: z.string().regex(HEX_64, "expected 64-char lowercase hex sha256"),
});

export type ManifestFile = z.infer<typeof ManifestFileSchema>;

/** On-chain manifest (cell data), TECHNICAL.md §3. */
export const ManifestSchema = z.object({
  app: z.literal("vericell"),
  v: z.literal(1),
  title: z.string().min(1),
  created: z.string().datetime({ offset: true }),
  source: z.string().url().optional(),
  project_sha256: z.string().regex(HEX_64, "expected 64-char lowercase hex sha256"),
  merkle_root: z.string().regex(HEX_64, "expected 64-char lowercase hex sha256"),
  count: z.number().int().nonnegative(),
  files: z.array(ManifestFileSchema).optional(),
  genesis: z.string().regex(TX_HASH, "expected 0x-prefixed 32-byte tx hash").optional(),
  prev: z.string().regex(TX_HASH, "expected 0x-prefixed 32-byte tx hash").optional(),
  declared_author: z.string().min(1).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

/** Encode a validated manifest as UTF-8 JSON bytes with a stable, canonical key order. */
export function encodeManifest(manifest: Manifest): Uint8Array {
  const parsed = ManifestSchema.parse(manifest);
  const ordered: Record<string, unknown> = {
    app: parsed.app,
    v: parsed.v,
    title: parsed.title,
    created: parsed.created,
  };
  if (parsed.source !== undefined) ordered.source = parsed.source;
  ordered.project_sha256 = parsed.project_sha256;
  ordered.merkle_root = parsed.merkle_root;
  ordered.count = parsed.count;
  if (parsed.files !== undefined) ordered.files = parsed.files.map((f) => ({ p: f.p, h: f.h }));
  if (parsed.genesis !== undefined) ordered.genesis = parsed.genesis;
  if (parsed.prev !== undefined) ordered.prev = parsed.prev;
  if (parsed.declared_author !== undefined) ordered.declared_author = parsed.declared_author;
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** Decode and validate manifest bytes; throws a ZodError (or SyntaxError) on invalid input. */
export function decodeManifest(bytes: Uint8Array): Manifest {
  const text = new TextDecoder().decode(bytes);
  const json: unknown = JSON.parse(text);
  return ManifestSchema.parse(json);
}
