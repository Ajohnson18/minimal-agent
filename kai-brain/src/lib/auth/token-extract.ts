import type { IncomingMessage } from "node:http";

export function parseBearerToken(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export function extractBearerTokenFromHeaders(headers: {
  authorization?: string | string[];
}): string | null {
  const raw = Array.isArray(headers.authorization)
    ? headers.authorization[0]
    : headers.authorization;
  return parseBearerToken(raw);
}

export interface WsTokenExtractOptions {
  allowQueryToken?: boolean;
  tokenParam?: string;
}

export function extractWsToken(
  request: IncomingMessage,
  options: WsTokenExtractOptions = {},
): string | null {
  const bearer = extractBearerTokenFromHeaders(request.headers);
  if (bearer) {
    return bearer;
  }

  const allowQueryToken = options.allowQueryToken ?? true;
  if (!allowQueryToken || !request.url) {
    return null;
  }

  try {
    const parsedUrl = new URL(request.url, "ws://localhost");
    const tokenParam = options.tokenParam ?? "token";
    const token = parsedUrl.searchParams.get(tokenParam)?.trim();
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
