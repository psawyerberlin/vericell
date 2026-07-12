import { describe, expect, it } from "vitest";
import { concatBytes, hexToBytes, sha256Hex } from "./hash.js";

describe("hexToBytes / concatBytes", () => {
  it("decodes a hex string to its bytes", () => {
    expect(hexToBytes("00ff10")).toEqual(new Uint8Array([0x00, 0xff, 0x10]));
  });

  it("rejects an odd-length hex string", () => {
    expect(() => hexToBytes("abc")).toThrow(/invalid hex string length/);
  });

  it("concatenates two byte sequences in order", () => {
    expect(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3, 4]))).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });
});

describe("sha256Hex", () => {
  it("hashes the empty input", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashes "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("accepts an ArrayBuffer", async () => {
    const buf = new TextEncoder().encode("abc").buffer;
    expect(await sha256Hex(buf)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
