import { afterEach, describe, expect, it } from "vitest";
import { resolveDbPath } from "./path.js";

describe("resolveDbPath", () => {
  afterEach(() => {
    delete globalThis.process.env.DB_PATH;
    delete globalThis.process.env.DB_DIR;
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
