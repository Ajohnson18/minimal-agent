import { beforeEach, describe, expect, test, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

import { validateUrl } from "../../../src/lib/ssrf-guard.js";

describe("ssrf-guard", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue({ address: "8.8.8.8", family: 4 });
  });

  test("rejects invalid or non-http urls", async () => {
    await expect(validateUrl("not-a-url")).rejects.toThrow("Invalid URL");
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow(
      "only http/https",
    );
  });

  test("blocks localhost and private ip literals", async () => {
    await expect(validateUrl("http://localhost:3000")).rejects.toThrow("Blocked");
    await expect(validateUrl("http://127.0.0.1")).rejects.toThrow("private IP");
  });

  test("blocks hostnames resolving to private ranges", async () => {
    lookupMock.mockResolvedValue({ address: "10.0.0.7", family: 4 });

    await expect(validateUrl("https://example.com")).rejects.toThrow(
      "resolves to private IP",
    );
  });

  test("allows public dns targets", async () => {
    lookupMock.mockResolvedValue({ address: "8.8.8.8", family: 4 });

    await expect(validateUrl("https://example.com")).resolves.toBeUndefined();
  });

  test("tolerates dns lookup failure", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(validateUrl("https://does-not-resolve.invalid")).resolves.toBeUndefined();
  });
});
