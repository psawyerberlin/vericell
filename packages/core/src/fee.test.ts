import { afterEach, describe, expect, it } from "vitest";
import { computeFee, FEE_WAIVER_SHANNONS, getFeeAddress, isFeeConfigured } from "./fee.js";

const SHANNONS_PER_CKB = 100_000_000n;
const ENV_VARS = [
  "VERICELL_FEE_ADDRESS_TESTNET",
  "VERICELL_FEE_ADDRESS_MAINNET",
  "VERICELL_FEE_ADDRESS_DEVNET",
];

function clearFeeEnv(): void {
  for (const name of ENV_VARS) delete process.env[name];
}

describe("computeFee", () => {
  it("waives the fee entirely below 300 CKB", () => {
    expect(computeFee(0n)).toBe(0n);
    expect(computeFee(61n * SHANNONS_PER_CKB)).toBe(0n);
    expect(computeFee(FEE_WAIVER_SHANNONS - 1n)).toBe(0n);
  });

  it("charges exactly 1% at and above the 300 CKB waiver threshold", () => {
    expect(computeFee(FEE_WAIVER_SHANNONS)).toBe(FEE_WAIVER_SHANNONS / 100n);
    expect(computeFee(1_000n * SHANNONS_PER_CKB)).toBe(10n * SHANNONS_PER_CKB);
  });

  it("floors to the nearest shannon rather than rounding", () => {
    // 300.00000001 CKB -> 1% = 3.0000000001 CKB worth of shannons, not a whole shannon multiple.
    const capacity = FEE_WAIVER_SHANNONS + 1n;
    const fee = computeFee(capacity);
    expect(fee).toBe((capacity * 1n) / 100n);
    expect(fee).toBe(300_000_000n); // floor(30000000001n / 100n)
  });

  it("floors down for a capacity not evenly divisible by 100", () => {
    // 301 CKB in shannons ends in ...00, but add 1 shannon to force a remainder.
    const capacity = 301n * SHANNONS_PER_CKB + 1n;
    expect(computeFee(capacity)).toBe((capacity - (capacity % 100n)) / 100n);
  });
});

describe("getFeeAddress / isFeeConfigured", () => {
  afterEach(() => {
    clearFeeEnv();
  });

  it("is undefined/disabled when no env var is set", () => {
    clearFeeEnv();
    expect(getFeeAddress("testnet")).toBeUndefined();
    expect(getFeeAddress("mainnet")).toBeUndefined();
    expect(getFeeAddress("devnet")).toBeUndefined();
    expect(isFeeConfigured("testnet")).toBe(false);
  });

  it("reads the network-scoped env var", () => {
    clearFeeEnv();
    process.env.VERICELL_FEE_ADDRESS_TESTNET = "ckt1qzda0...testaddress";
    expect(getFeeAddress("testnet")).toBe("ckt1qzda0...testaddress");
    expect(getFeeAddress("mainnet")).toBeUndefined();
    expect(isFeeConfigured("testnet")).toBe(true);
    expect(isFeeConfigured("mainnet")).toBe(false);
  });

  it("treats an empty/whitespace-only value as unconfigured", () => {
    clearFeeEnv();
    process.env.VERICELL_FEE_ADDRESS_MAINNET = "   ";
    expect(getFeeAddress("mainnet")).toBeUndefined();
    expect(isFeeConfigured("mainnet")).toBe(false);
  });

  it("keeps testnet and mainnet independently configurable", () => {
    clearFeeEnv();
    process.env.VERICELL_FEE_ADDRESS_TESTNET = "ckt1qtest";
    process.env.VERICELL_FEE_ADDRESS_MAINNET = "ckb1qmain";
    expect(getFeeAddress("testnet")).toBe("ckt1qtest");
    expect(getFeeAddress("mainnet")).toBe("ckb1qmain");
  });
});
