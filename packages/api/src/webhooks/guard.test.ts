import { describe, expect, it } from "vitest";
import { ProblemError } from "../server/errors.js";
import { assertPublicWebhookUrl, isPrivateIpv4, isPrivateIpv6 } from "./guard.js";

describe("isPrivateIpv4", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.0.0.1", true],
    ["172.16.5.5", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.1.1", true],
    ["100.64.0.5", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["172.32.0.1", false], // just outside 172.16.0.0/12
    ["172.15.255.255", false], // just below 172.16.0.0/12
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateIpv4(ip)).toBe(expected);
  });
});

describe("isPrivateIpv6", () => {
  it.each([
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fd12:3456:789a::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback
    ["::ffff:10.0.0.5", true], // IPv4-mapped private
    ["2001:4860:4860::8888", false], // Google public DNS
    ["::ffff:8.8.8.8", false], // IPv4-mapped public
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateIpv6(ip)).toBe(expected);
  });
});

describe("assertPublicWebhookUrl", () => {
  it("rejects a URL whose literal IPv4 host is private, without calling DNS", async () => {
    const lookupFn = async () => {
      throw new Error("should not be called for a literal IP host");
    };
    await expect(
      assertPublicWebhookUrl("http://127.0.0.1:4000/hook", { lookupFn }),
    ).rejects.toBeInstanceOf(ProblemError);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    const lookupFn = async () => [{ address: "10.1.2.3", family: 4 }];
    await expect(
      assertPublicWebhookUrl("http://internal.example.test/hook", { lookupFn }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    const lookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
    await expect(
      assertPublicWebhookUrl("https://example.test/hook", { lookupFn }),
    ).resolves.toBeUndefined();
  });

  it("rejects if any resolved address (out of several) is private", async () => {
    const lookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.0.1", family: 4 },
    ];
    await expect(
      assertPublicWebhookUrl("https://example.test/hook", { lookupFn }),
    ).rejects.toBeInstanceOf(ProblemError);
  });

  it("rejects a non-http(s) protocol", async () => {
    await expect(assertPublicWebhookUrl("ftp://example.test/hook")).rejects.toBeInstanceOf(
      ProblemError,
    );
  });

  it("rejects a malformed URL", async () => {
    await expect(assertPublicWebhookUrl("not a url")).rejects.toBeInstanceOf(ProblemError);
  });

  it("WEBHOOK_ALLOW_PRIVATE_NETWORKS escape hatch bypasses the guard entirely", async () => {
    const lookupFn = async () => {
      throw new Error("should not be called when the escape hatch is set");
    };
    await expect(
      assertPublicWebhookUrl("http://127.0.0.1:4000/hook", {
        lookupFn,
        env: { WEBHOOK_ALLOW_PRIVATE_NETWORKS: "1" },
      }),
    ).resolves.toBeUndefined();
  });
});
