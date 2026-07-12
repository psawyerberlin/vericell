import { describe, expect, it } from "vitest";
import { decodeManifest, encodeManifest, ManifestSchema, type Manifest } from "./manifest.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TX_HASH = "0x" + "1".repeat(64);

const baseManifest: Manifest = {
  app: "vericell",
  v: 1,
  title: "EasyTransfer v1.4.0",
  created: "2026-07-10T12:00:00Z",
  source: "https://github.com/you/easytransfer",
  project_sha256: HASH_A,
  merkle_root: HASH_B,
  count: 2,
  files: [
    { p: "src/main.js", h: HASH_A },
    { p: "README.md", h: HASH_B },
  ],
};

describe("ManifestSchema", () => {
  it("accepts a full manifest", () => {
    expect(ManifestSchema.parse(baseManifest)).toBeTruthy();
  });

  it("accepts a compact manifest (no files) with genesis/prev/declared_author", () => {
    const compact: Manifest = {
      app: "vericell",
      v: 1,
      title: "compact",
      created: "2026-07-10T12:00:00Z",
      project_sha256: HASH_A,
      merkle_root: HASH_B,
      count: 5,
      genesis: TX_HASH,
      prev: TX_HASH,
      declared_author: "alice",
    };
    expect(ManifestSchema.parse(compact)).toBeTruthy();
  });

  it.each([
    ["wrong app literal", { ...baseManifest, app: "notvericell" }],
    ["wrong v literal", { ...baseManifest, v: 2 }],
    ["empty title", { ...baseManifest, title: "" }],
    ["non-ISO created", { ...baseManifest, created: "not-a-date" }],
    ["bad source url", { ...baseManifest, source: "not-a-url" }],
    ["short project_sha256", { ...baseManifest, project_sha256: "abc" }],
    ["uppercase merkle_root", { ...baseManifest, merkle_root: HASH_B.toUpperCase() }],
    ["negative count", { ...baseManifest, count: -1 }],
    ["bad genesis tx hash", { ...baseManifest, genesis: "not-a-tx-hash" }],
    [
      "missing required field",
      (() => {
        const rest: Record<string, unknown> = { ...baseManifest };
        delete rest.title;
        return rest;
      })(),
    ],
  ])("rejects: %s", (_label, invalid) => {
    expect(ManifestSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("encodeManifest / decodeManifest", () => {
  it("round-trips a full manifest", () => {
    const decoded = decodeManifest(encodeManifest(baseManifest));
    expect(decoded).toEqual(baseManifest);
  });

  it("round-trips a versioned, custodial manifest (genesis + prev + declared_author)", () => {
    const versioned: Manifest = {
      ...baseManifest,
      genesis: TX_HASH,
      prev: TX_HASH,
      declared_author: "alice",
    };
    const decoded = decodeManifest(encodeManifest(versioned));
    expect(decoded).toEqual(versioned);
  });

  it("round-trips a compact manifest without files", () => {
    const compact: Manifest = {
      app: "vericell",
      v: 1,
      title: "compact",
      created: "2026-07-10T12:00:00Z",
      project_sha256: HASH_A,
      merkle_root: HASH_B,
      count: 5,
    };
    const decoded = decodeManifest(encodeManifest(compact));
    expect(decoded).toEqual(compact);
  });

  it("produces stable key order regardless of input key order", () => {
    const reordered = {
      count: baseManifest.count,
      v: baseManifest.v,
      app: baseManifest.app,
      title: baseManifest.title,
      merkle_root: baseManifest.merkle_root,
      created: baseManifest.created,
      project_sha256: baseManifest.project_sha256,
      source: baseManifest.source,
      files: baseManifest.files,
    } as Manifest;
    expect(new TextDecoder().decode(encodeManifest(reordered))).toBe(
      new TextDecoder().decode(encodeManifest(baseManifest)),
    );
  });

  it("encodes as UTF-8 JSON", () => {
    const bytes = encodeManifest(baseManifest);
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    expect(json).toMatchObject({ app: "vericell", v: 1 });
  });

  it("throws when decoding an invalid manifest", () => {
    const bad = new TextEncoder().encode(JSON.stringify({ app: "vericell" }));
    expect(() => decodeManifest(bad)).toThrow();
  });

  it("throws when decoding non-JSON bytes", () => {
    const bad = new TextEncoder().encode("not json");
    expect(() => decodeManifest(bad)).toThrow();
  });
});
