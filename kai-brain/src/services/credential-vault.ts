import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  if (env.CREDENTIAL_ENCRYPTION_KEY) {
    const raw = env.CREDENTIAL_ENCRYPTION_KEY;
    if (raw.length === 64) return Buffer.from(raw, "hex");
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)");
  }
  // Derive from JWT_SECRET via HMAC-SHA256 for dev convenience
  return createHmac("sha256", env.JWT_SECRET).update("ava-credential-vault").digest();
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = getEncryptionKey();
  return cachedKey;
}

/**
 * Encrypt plaintext string. Returns `base64(iv):base64(authTag):base64(ciphertext)`.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a string produced by `encrypt()`. Returns plaintext.
 */
export function decrypt(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload format");
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key(), iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(data) + decipher.final("utf8");
}

/**
 * Encrypt a credentials object to a storable string.
 */
export function encryptCredentials<T>(credentials: T): string {
  return encrypt(JSON.stringify(credentials));
}

/**
 * Decrypt a stored string back to a credentials object.
 * Returns null if the payload is null/empty or decryption fails.
 */
export function decryptCredentials<T>(payload: string | null | undefined): T | null {
  if (!payload) return null;
  try {
    return JSON.parse(decrypt(payload)) as T;
  } catch {
    return null;
  }
}
