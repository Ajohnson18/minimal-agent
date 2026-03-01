export type SlackTargetKind = "channel" | "user";

export interface ParsedSlackTarget {
  kind: SlackTargetKind;
  id: string;
}

function normalizeId(id: string): string {
  return id.trim();
}

function isLikelyChannelId(value: string): boolean {
  return /^[CDG][A-Z0-9]+$/i.test(value);
}

function isLikelyUserId(value: string): boolean {
  return /^U[A-Z0-9]+$/i.test(value);
}

export function normalizeSlackChannelId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("channelId is required");
  }

  const prefixed = /^channel:(.+)$/i.exec(value);
  if (prefixed) {
    const id = normalizeId(prefixed[1] || "");
    if (!id) {
      throw new Error("channelId after channel: must not be empty");
    }
    return id;
  }

  if (!isLikelyChannelId(value)) {
    throw new Error(
      `Invalid channelId "${raw}". Use channel:<ID> or a raw channel ID like C12345678.`,
    );
  }

  return value;
}

export function parseSlackTarget(raw: string): ParsedSlackTarget {
  const value = raw.trim();
  if (!value) {
    throw new Error("to is required");
  }

  const prefixed = /^(channel|user):(.+)$/i.exec(value);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase() as SlackTargetKind;
    const id = normalizeId(prefixed[2] || "");
    if (!id) {
      throw new Error(`Invalid target "${raw}": missing ID after ${kind}: prefix.`);
    }
    return { kind, id };
  }

  if (isLikelyUserId(value)) {
    return { kind: "user", id: value };
  }
  if (isLikelyChannelId(value)) {
    return { kind: "channel", id: value };
  }

  throw new Error(
    `Invalid target "${raw}". Use channel:<ID>, user:<ID>, raw C... channel IDs, or raw U... user IDs.`,
  );
}
