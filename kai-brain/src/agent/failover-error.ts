export type FailoverErrorClass =
  | "abort"
  | "cancel"
  | "rate_limit"
  | "model_deprecated"
  | "model_unsupported"
  | "provider_transient"
  | "auth"
  | "retryable"
  | "unknown";

export interface FailoverErrorDecision {
  class: FailoverErrorClass;
  retryable: boolean;
  reason: string;
}

function normalizeMessage(value: unknown): string {
  if (value instanceof Error) return value.message.toLowerCase();
  if (typeof value === "string") return value.toLowerCase();
  if (value && typeof value === "object") {
    const maybeMessage = (value as Record<string, unknown>)["message"];
    if (typeof maybeMessage === "string") {
      return maybeMessage.toLowerCase();
    }
  }
  return String(value ?? "").toLowerCase();
}

export function classifyFailoverError(value: unknown): FailoverErrorDecision {
  const message = normalizeMessage(value);

  if (
    message.includes("aborted") ||
    message.includes("aborterror") ||
    message.includes("signal is aborted")
  ) {
    return { class: "abort", retryable: false, reason: "aborted" };
  }

  if (message.includes("cancelled") || message.includes("canceled")) {
    return { class: "cancel", retryable: false, reason: "cancelled" };
  }

  if (
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("invalid api key") ||
    message.includes("no api key found") ||
    message.includes("authentication") ||
    message.includes("auth failed") ||
    message.includes("permission denied")
  ) {
    return { class: "auth", retryable: false, reason: "auth" };
  }

  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota exceeded") ||
    /\b429\b/.test(message)
  ) {
    return { class: "rate_limit", retryable: true, reason: "rate-limit" };
  }

  if (
    message.includes("deprecated") ||
    message.includes("sunset") ||
    message.includes("retired") ||
    message.includes("no longer available")
  ) {
    return {
      class: "model_deprecated",
      retryable: true,
      reason: "model-deprecated",
    };
  }

  if (
    message.includes("unsupported model") ||
    message.includes("model not found") ||
    message.includes("unknown model") ||
    message.includes("is not supported")
  ) {
    return {
      class: "model_unsupported",
      retryable: true,
      reason: "model-unsupported",
    };
  }

  if (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("service unavailable") ||
    message.includes("gateway timeout") ||
    message.includes("connection reset") ||
    message.includes("network error") ||
    /\b5\d{2}\b/.test(message)
  ) {
    return {
      class: "provider_transient",
      retryable: true,
      reason: "provider-transient",
    };
  }

  if (message.length > 0) {
    return { class: "retryable", retryable: true, reason: "runtime-error" };
  }

  return { class: "unknown", retryable: true, reason: "unknown-error" };
}
