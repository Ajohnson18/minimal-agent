/**
 * Gateway wire protocol types.
 *
 * OpenClaw-style typed frames:
 * - Request:  { type: "req", id, method, params }
 * - Response: { type: "res", id, ok, payload?, error? }
 * - Event:    { type: "event", event, payload, seq?, stateVersion? }
 */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: RpcError;
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: Record<string, number>;
}

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

/**
 * Backward-compat aliases used by existing imports.
 */
export type RpcRequest = RequestFrame;
export type RpcResponse = ResponseFrame;
export type RpcEvent = EventFrame;

export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_FOUND: -32001,
  UNAUTHORIZED: -32002,
  ALREADY_EXISTS: -32003,
  TIMEOUT: -32004,
  SANDBOX_UNAVAILABLE: -32005,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function createError(
  code: ErrorCode,
  message: string,
  data?: unknown,
): RpcError {
  return { code, message, data };
}

export function createSuccessResponse(id: string, payload?: unknown): ResponseFrame {
  return {
    type: "res",
    id,
    ok: true,
    ...(typeof payload === "undefined" ? {} : { payload }),
  };
}

export function createErrorResponse(id: string, error: RpcError): ResponseFrame {
  return {
    type: "res",
    id,
    ok: false,
    error,
  };
}

export function isRequestFrame(data: unknown): data is RequestFrame {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as RequestFrame).type === "req" &&
    typeof (data as RequestFrame).id === "string" &&
    typeof (data as RequestFrame).method === "string"
  );
}
