import { describe, expect, it } from "vitest";
import type { Manifest } from "core";
import { CliError } from "./cliError.js";
import { toManifestDraft } from "./manifestDraft.js";

const BASE: Manifest = {
  app: "vericell",
  v: 1,
  title: "Test Project",
  created: "2026-01-01T00:00:00.000Z",
  project_sha256: "a".repeat(64),
  merkle_root: "b".repeat(64),
  count: 1,
  files: [{ p: "a.txt", h: "a".repeat(64) }],
};

describe("toManifestDraft", () => {
  it("carries title/created/source/files through, omitting computed fields", () => {
    const manifest: Manifest = { ...BASE, source: "https://example.com/repo" };
    const draft = toManifestDraft(manifest);
    expect(draft).toEqual({
      title: "Test Project",
      created: "2026-01-01T00:00:00.000Z",
      source: "https://example.com/repo",
      files: BASE.files,
    });
  });

  it("omits source when the manifest has none", () => {
    const draft = toManifestDraft(BASE);
    expect(draft).not.toHaveProperty("source");
  });

  it("throws a CliError when the manifest has no files (e.g. hashed with --compact)", () => {
    const compact: Manifest = { ...BASE, files: undefined };
    expect(() => toManifestDraft(compact)).toThrow(CliError);
    expect(() => toManifestDraft(compact)).toThrow(/--compact/);
  });

  it("throws a CliError when files is an empty array", () => {
    const empty: Manifest = { ...BASE, files: [] };
    expect(() => toManifestDraft(empty)).toThrow(CliError);
  });
});
