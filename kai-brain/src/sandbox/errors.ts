export const SANDBOX_UNAVAILABLE_CODE = "SANDBOX_UNAVAILABLE";

export interface SandboxUnavailableContext {
  userId: string;
  sessionId: string;
  scopeKey: string;
  mode: string;
  image: string;
  network: string;
}

export class SandboxUnavailableError extends Error {
  readonly code = SANDBOX_UNAVAILABLE_CODE;
  readonly context: SandboxUnavailableContext;

  constructor(
    message: string,
    context: SandboxUnavailableContext,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SandboxUnavailableError";
    this.context = context;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function isSandboxUnavailableError(
  error: unknown,
): error is SandboxUnavailableError {
  if (error instanceof SandboxUnavailableError) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === SANDBOX_UNAVAILABLE_CODE;
}
