export interface SlackTimestampFields {
  timestampMs?: number;
  timestampUtc?: string;
}

export function parseSlackTimestamp(ts: unknown): SlackTimestampFields {
  const numericTs =
    typeof ts === "number"
      ? ts
      : typeof ts === "string" && ts.trim().length > 0
        ? Number.parseFloat(ts)
        : Number.NaN;

  if (!Number.isFinite(numericTs)) {
    return {};
  }

  const timestampMs = Math.round(numericTs * 1000);
  return {
    timestampMs,
    timestampUtc: new Date(timestampMs).toISOString(),
  };
}

export function withSlackTimestamp<T extends Record<string, unknown>>(
  value: T,
  ts: unknown,
): T & SlackTimestampFields {
  const normalized = parseSlackTimestamp(ts);
  if (normalized.timestampMs == null || normalized.timestampUtc == null) {
    return value as T & SlackTimestampFields;
  }
  return {
    ...value,
    ...normalized,
  };
}
