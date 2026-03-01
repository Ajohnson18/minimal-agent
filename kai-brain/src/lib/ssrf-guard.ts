/**
 * SSRF Protection
 *
 * Validates URLs and resolved IPs to prevent Server-Side Request Forgery.
 */
import { lookup } from "node:dns/promises";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
  "169.254.169.254",
  "metadata",
  "[::1]",
]);

function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.match(/^172\.(1[6-9]|2\d|3[01])\./)) return true;
  if (ip === "0.0.0.0") return true;
  // IPv6 private
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("fe80:")) return true;
  return false;
}

export async function validateUrl(urlStr: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked: only http/https allowed, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known internal hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked: ${hostname} is not allowed (SSRF protection)`);
  }

  // If it's an IP literal, check directly
  if (isPrivateIP(hostname)) {
    throw new Error(`Blocked: ${hostname} is a private IP (SSRF protection)`);
  }

  // DNS resolution check
  try {
    const result = await lookup(hostname);
    if (isPrivateIP(result.address)) {
      throw new Error(
        `Blocked: ${hostname} resolves to private IP ${result.address} (SSRF protection)`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Blocked:")) {
      throw error;
    }
    // DNS resolution failure is ok — fetch will fail naturally
  }
}
