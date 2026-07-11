import { describe, expect, it } from "vitest";
import { projectHash } from "./projectHash.js";

describe("projectHash", () => {
  // Vector computed independently with Node's `crypto` module: sha256 of each
  // file's content, then sha256 over sort_by_path("path\nhash\n" ...).
  const entries = [
    {
      path: "src/main.js",
      hash: "35c146f76e129477c64061bc84511e1090f3d4d8059713e6663dd4b35b1f7642",
    },
    { path: "README.md", hash: "ea67f39f2a707e536439ee31e49fdd586b4a8437d3408f0466112d040cd06681" },
    {
      path: "a/nested/file.txt",
      hash: "b509163964e822915ea7e822759ecae39dd696626e70b74b96de6ac7396415d0",
    },
  ];

  it("matches the hand-computed 3-file vector", async () => {
    expect(await projectHash(entries)).toBe(
      "bf2a54e0564d97f9865e5cb6eb2a25593656753d68bc63568e12a3894d8e8c8c",
    );
  });

  it("is independent of input order (sorts by path)", async () => {
    const shuffled = [entries[2], entries[0], entries[1]] as typeof entries;
    expect(await projectHash(shuffled)).toBe(await projectHash(entries));
  });
});
