import { describe, expect, it } from "vitest";
import { estimateCellCost } from "./cost.js";
import { encodeManifest, type Manifest } from "./manifest.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const manifest: Manifest = {
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

describe("estimateCellCost", () => {
  it("adds the 61 CKB cell overhead to the encoded byte length", () => {
    const { full } = estimateCellCost(manifest);
    expect(full).toBe(encodeManifest(manifest).length + 61);
  });

  it("compact figure is smaller than full when files are present", () => {
    const { full, compact } = estimateCellCost(manifest);
    expect(compact).toBeLessThan(full);
  });

  it("compact figure omits the files array entirely", () => {
    const withoutFiles: Manifest = { ...manifest };
    delete withoutFiles.files;
    const { compact } = estimateCellCost(manifest);
    expect(compact).toBe(encodeManifest(withoutFiles).length + 61);
  });

  it("full equals compact when there are no files to begin with", () => {
    const noFiles: Manifest = {
      app: "vericell",
      v: 1,
      title: "compact",
      created: "2026-07-10T12:00:00Z",
      project_sha256: HASH_A,
      merkle_root: HASH_B,
      count: 5,
    };
    const { full, compact } = estimateCellCost(noFiles);
    expect(full).toBe(compact);
  });
});
