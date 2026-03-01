export type SessionKey = string & { readonly __brand: 'SessionKey' };

export interface SessionKeyParts {
  scope: string;
  channel?: string;
  conversationId?: string;
  threadId?: string;
}

const VALID_PART_RE = /^[a-z0-9][a-z0-9:_\-.]*$/i;

function sanitizePart(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9:_\-.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function normalizeSessionKey(raw: string | null | undefined): SessionKey {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    throw new Error('sessionKey is required');
  }

  const normalized = sanitizePart(trimmed);
  if (!normalized || !VALID_PART_RE.test(normalized)) {
    throw new Error(`Invalid sessionKey: "${raw ?? ''}"`);
  }

  return normalized as SessionKey;
}

export function tryNormalizeSessionKey(raw: string | null | undefined): SessionKey | null {
  try {
    return normalizeSessionKey(raw);
  } catch {
    return null;
  }
}

export function buildSessionKey(parts: SessionKeyParts): SessionKey {
  const scope = sanitizePart(parts.scope || 'main');
  const channel = sanitizePart(parts.channel || '');
  const conversationId = sanitizePart(parts.conversationId || '');
  const threadId = sanitizePart(parts.threadId || '');

  const segments = ['agent', scope];

  if (channel) segments.push(channel);
  if (conversationId) segments.push(conversationId);
  if (threadId) segments.push('thread', threadId);

  return normalizeSessionKey(segments.join(':'));
}

export function parseSessionKey(raw: string | null | undefined): SessionKeyParts | null {
  const normalized = tryNormalizeSessionKey(raw);
  if (!normalized) return null;

  const segments = normalized.split(':');
  if (segments.length < 2 || segments[0] !== 'agent') {
    return {
      scope: segments[0] ?? 'main',
    };
  }

  const scope = segments[1] ?? 'main';
  let channel: string | undefined;
  let conversationId: string | undefined;
  let threadId: string | undefined;

  if (segments.length >= 3) channel = segments[2];
  if (segments.length >= 4) conversationId = segments[3];

  const threadMarkerIndex = segments.findIndex((seg) => seg === 'thread');
  if (threadMarkerIndex >= 0 && threadMarkerIndex + 1 < segments.length) {
    threadId = segments[threadMarkerIndex + 1];
  }

  return {
    scope,
    ...(channel ? { channel } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}
