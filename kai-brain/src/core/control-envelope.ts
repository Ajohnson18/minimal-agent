export type ControlEnvelopeAction =
  | 'deliver'
  | 'suppress'
  | 'heartbeat_ack'
  | 'error';

export interface ControlEnvelope {
  v: 1;
  action: ControlEnvelopeAction;
  message?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryControlDeliver {
  mode: 'deliver';
  text: string;
  reason?: string;
}

export interface DeliveryControlSuppress {
  mode: 'suppress';
  reason: string;
}

export type DeliveryControl = DeliveryControlDeliver | DeliveryControlSuppress;

export const CONTROL_ENVELOPE_REQUIREMENT = [
  "Return exactly one JSON object (no markdown).",
  'Schema: {"v":1,"action":"deliver|suppress|heartbeat_ack","message":"...","reason":"..."}.',
  'Use action="deliver" when the user should receive a message and put that message in "message".',
  'Use action="heartbeat_ack" when nothing should be delivered.',
  'Use action="suppress" only when delivery should be intentionally skipped (duplicate/already handled).',
].join(" ");

const LEGACY_CONTROL_TOKEN_TO_ENVELOPE: Record<string, ControlEnvelope> = {
  NO_REPLY: {
    v: 1,
    action: "suppress",
    reason: "legacy-no-reply-token",
  },
  HEARTBEAT_OK: {
    v: 1,
    action: "heartbeat_ack",
    reason: "legacy-heartbeat-ok-token",
  },
  ANNOUNCE_SKIP: {
    v: 1,
    action: "suppress",
    reason: "legacy-announce-skip-token",
  },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLegacyTokenCandidate(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "")
    .trim();
}

function isLegacyTokenBoundaryMatch(text: string, token: string): boolean {
  if (!text) return false;
  const escaped = escapeRegExp(token);
  const prefix = new RegExp(`^\\s*${escaped}(?=$|\\W)`);
  if (prefix.test(text)) {
    return true;
  }
  const suffix = new RegExp(`\\b${escaped}\\b\\W*$`);
  return suffix.test(text);
}

function parseLegacyControlToken(text: string): ControlEnvelope | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeLegacyTokenCandidate(trimmed);
  for (const [token, envelope] of Object.entries(LEGACY_CONTROL_TOKEN_TO_ENVELOPE)) {
    if (
      isLegacyTokenBoundaryMatch(trimmed, token) ||
      isLegacyTokenBoundaryMatch(normalized, token)
    ) {
      return { ...envelope };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseControlEnvelope(text: string | undefined): ControlEnvelope | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const v = parsed['v'];
  const action = parsed['action'];
  if (v !== 1) return null;
  if (
    action !== 'deliver' &&
    action !== 'suppress' &&
    action !== 'heartbeat_ack' &&
    action !== 'error'
  ) {
    return null;
  }

  const message = typeof parsed['message'] === 'string' ? parsed['message'] : undefined;
  const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : undefined;
  const metadata = isRecord(parsed['metadata'])
    ? (parsed['metadata'] as Record<string, unknown>)
    : undefined;

  return {
    v: 1,
    action,
    ...(message ? { message } : {}),
    ...(reason ? { reason } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function parseControlEnvelopeWithLegacyFallback(
  text: string | undefined,
): ControlEnvelope | null {
  const parsed = parseControlEnvelope(text);
  if (parsed) {
    return parsed;
  }

  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return null;
  }
  return parseLegacyControlToken(trimmed);
}

export function toDeliveryControl(
  envelope: ControlEnvelope | null,
  fallbackText: string,
): DeliveryControl {
  if (!envelope) {
    return {
      mode: 'deliver',
      text: fallbackText,
    };
  }

  if (envelope.action === 'suppress' || envelope.action === 'heartbeat_ack') {
    return {
      mode: 'suppress',
      reason: envelope.reason ?? envelope.action,
    };
  }

  if (envelope.action === 'error') {
    return {
      mode: 'deliver',
      text: envelope.message?.trim() || fallbackText,
      reason: envelope.reason ?? 'error',
    };
  }

  return {
    mode: 'deliver',
    text: envelope.message?.trim() || fallbackText,
    reason: envelope.reason,
  };
}
