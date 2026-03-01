import { describe, expect, test } from "vitest";

import {
  decrypt,
  decryptCredentials,
  encrypt,
  encryptCredentials,
} from "../../../src/services/credential-vault.js";

describe("credential-vault", () => {
  test("encrypt/decrypt roundtrip", () => {
    const plaintext = "super-secret";
    const encrypted = encrypt(plaintext);

    expect(encrypted).toContain(":");
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  test("encryptCredentials/decryptCredentials roundtrip", () => {
    const creds = {
      custom: [{ key: "api_key", value: "token" }],
    };

    const encrypted = encryptCredentials(creds);
    const decrypted = decryptCredentials<typeof creds>(encrypted);

    expect(decrypted).toEqual(creds);
  });

  test("returns null for malformed credential payloads", () => {
    expect(decryptCredentials("not-valid")).toBeNull();
    expect(decryptCredentials(null)).toBeNull();
    expect(decryptCredentials(undefined)).toBeNull();
  });
});
