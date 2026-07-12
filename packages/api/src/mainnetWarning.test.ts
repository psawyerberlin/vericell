import { describe, expect, it, vi } from "vitest";
import { warnIfMainnet } from "./mainnetWarning.js";

describe("warnIfMainnet", () => {
  it("logs a warning on mainnet", () => {
    const warn = vi.fn();
    warnIfMainnet({ warn }, "mainnet");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/MAINNET/);
  });

  it("stays silent on testnet and devnet", () => {
    const warn = vi.fn();
    warnIfMainnet({ warn }, "testnet");
    warnIfMainnet({ warn }, "devnet");
    expect(warn).not.toHaveBeenCalled();
  });
});
