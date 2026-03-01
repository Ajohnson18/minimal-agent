/**
 * Helpers for suppressing duplicate final replies when messaging tools
 * already delivered equivalent content.
 */

type SlackMessageCallArgs = {
  message?: unknown;
  text?: unknown;
  caption?: unknown;
};

type SlackActionsCallArgs = {
  action?: unknown;
  content?: unknown;
  text?: unknown;
};

export interface MessagingToolCallLike {
  name?: string;
  args?: unknown;
}

function getTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract the user-visible text payload for Slack messaging tools.
 * Returns null for non-messaging calls or calls without a text payload.
 */
export function extractMessagingToolSentText(
  call: MessagingToolCallLike | undefined,
): string | null {
  if (!call?.name) return null;

  if (call.name === "slack_message") {
    const args = (call.args ?? {}) as SlackMessageCallArgs;
    return (
      getTrimmedString(args.message) ||
      getTrimmedString(args.text) ||
      getTrimmedString(args.caption)
    );
  }

  if (call.name === "slack_actions") {
    const args = (call.args ?? {}) as SlackActionsCallArgs;
    const action = getTrimmedString(args.action);
    if (action !== "sendMessage") return null;
    return getTrimmedString(args.content) || getTrimmedString(args.text);
  }

  return null;
}
