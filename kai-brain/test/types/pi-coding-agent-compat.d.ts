import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static, TSchema } from "@sinclair/typebox";

declare module "@mariozechner/pi-coding-agent" {
  interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
    execute(
      toolCallId: string,
      params: Static<TParams>,
    ): Promise<AgentToolResult<TDetails>>;
  }
}
