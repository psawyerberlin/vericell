import { describe, expect, it } from "vitest";
import { ccc } from "chain";
import { ProblemError } from "./errors.js";
import { txFromJson, txToJson } from "./txJson.js";

describe("txToJson / txFromJson", () => {
  it("round-trips a transaction (same hash before and after)", () => {
    const tx = ccc.Transaction.from({
      outputs: [
        {
          capacity: 1000n,
          lock: { codeHash: "0x" + "11".repeat(32), hashType: "type", args: "0x" },
        },
      ],
      outputsData: ["0x1234"],
    });
    const roundTripped = txFromJson(txToJson(tx));
    expect(roundTripped.hash()).toBe(tx.hash());
  });

  it("wraps an unparseable transaction as a 400 ProblemError", () => {
    expect(() => txFromJson(null)).toThrow(ProblemError);
    try {
      txFromJson(null);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemError);
      expect((err as ProblemError).statusCode).toBe(400);
      expect((err as ProblemError).detail).toMatch(/Invalid transaction/);
    }
  });

  it("wraps a structurally-invalid field (bad capacity) as a 400 ProblemError", () => {
    expect(() =>
      txFromJson({ outputs: [{ capacity: "not-hex", lock: {} }], outputsData: ["0x"] }),
    ).toThrow(ProblemError);
  });
});
