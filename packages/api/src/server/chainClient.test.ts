import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCustodialEnabled } from "./chainClient.js";

describe("resolveCustodialEnabled", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("is false when CUSTODIAL_ENABLED isn't set", () => {
    expect(resolveCustodialEnabled("testnet", {})).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["1", "true", "TRUE"])("is true on testnet/devnet when CUSTODIAL_ENABLED=%s", (value) => {
    expect(resolveCustodialEnabled("testnet", { CUSTODIAL_ENABLED: value })).toBe(true);
    expect(resolveCustodialEnabled("devnet", { CUSTODIAL_ENABLED: value })).toBe(true);
  });

  it("refuses on mainnet without MAINNET_CONFIRM=1, and warns loudly", () => {
    const result = resolveCustodialEnabled("mainnet", { CUSTODIAL_ENABLED: "1" });
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/MAINNET_CONFIRM/);
  });

  it('refuses on mainnet even with MAINNET_CONFIRM set to something other than "1"', () => {
    expect(
      resolveCustodialEnabled("mainnet", { CUSTODIAL_ENABLED: "1", MAINNET_CONFIRM: "true" }),
    ).toBe(false);
  });

  it("allows custodial mode on mainnet when both flags are set", () => {
    const result = resolveCustodialEnabled("mainnet", {
      CUSTODIAL_ENABLED: "1",
      MAINNET_CONFIRM: "1",
    });
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
