import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDbPath } from "./path.js";

// resolveDbPath reads these directly from process.env, so an operator's own
// shell exporting DB_PATH/DB_DIR (e.g. left over from running the API
// manually) would otherwise leak into the "default" test below. Saved
// before each test and restored after, rather than an unconditional
// delete, so a real ambient value isn't dropped for the rest of the run.
const ORIGINAL_DB_PATH = globalThis.process.env.DB_PATH;
const ORIGINAL_DB_DIR = globalThis.process.env.DB_DIR;

describe("resolveDbPath", () => {
  beforeEach(() => {
    delete globalThis.process.env.DB_PATH;
    delete globalThis.process.env.DB_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_DB_PATH === undefined) {
      delete globalThis.process.env.DB_PATH;
    } else {
      globalThis.process.env.DB_PATH = ORIGINAL_DB_PATH;
    }
    if (ORIGINAL_DB_DIR === undefined) {
      delete globalThis.process.env.DB_DIR;
    } else {
      globalThis.process.env.DB_DIR = ORIGINAL_DB_DIR;
    }
  });

  it("is network-scoped by default, under ./data", () => {
    expect(resolveDbPath("testnet")).toBe("data/vericell.testnet.sqlite");
    expect(resolveDbPath("mainnet")).toBe("data/vericell.mainnet.sqlite");
    expect(resolveDbPath("devnet")).toBe("data/vericell.devnet.sqlite");
  });

  it("honors DB_DIR for the directory, keeping the network-scoped filename", () => {
    globalThis.process.env.DB_DIR = "/srv/vericell";
    expect(resolveDbPath("testnet")).toBe("/srv/vericell/vericell.testnet.sqlite");
  });

  it("DB_PATH overrides everything (trusted to already be network-scoped)", () => {
    globalThis.process.env.DB_PATH = "/custom/path.sqlite";
    globalThis.process.env.DB_DIR = "/ignored";
    expect(resolveDbPath("mainnet")).toBe("/custom/path.sqlite");
  });
});
