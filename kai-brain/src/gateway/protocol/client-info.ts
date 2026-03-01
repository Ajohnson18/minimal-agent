export const GATEWAY_CLIENT_CAPS = {
  TOOL_EVENTS: "tool-events",
} as const;

export type GatewayClientCap =
  (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];

export function hasGatewayClientCap(
  caps: ReadonlySet<string> | string[] | null | undefined,
  cap: GatewayClientCap,
): boolean {
  if (!caps) return false;
  if (caps instanceof Set) {
    return caps.has(cap);
  }
  if (!Array.isArray(caps)) {
    return false;
  }
  return caps.includes(cap);
}
