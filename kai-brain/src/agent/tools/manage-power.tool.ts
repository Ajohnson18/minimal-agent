import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { reloadPowers, deletePower } from "../../powers/registry.js";
import { getWritablePowersDir } from "../../powers/config.js";

const ManagePowerSchema = Type.Object({
  action: Type.String({
    description: 'Action: "reload" (re-scan power files from disk), "disable" / "enable" (toggle a power), "lock" / "unlock" (prevent/allow auto-rewrite), "delete" (remove a power), "get_powers_dir" (return the directory to write POWER.md files to)',
  }),
  power_id: Type.Optional(Type.String({
    description: "Power ID (required for disable/enable/lock/unlock/delete)",
  })),
});

type ManagePowerArgs = Static<typeof ManagePowerSchema>;

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}

export function createManagePowerTool(_context: {
  sessionId: string;
}): ToolDefinition {
  return {
    name: "manage_power",
    label: "Manage Power",
    description:
      "Manage power metadata. To CREATE or UPDATE a power, write the POWER.md file directly using the write tool " +
      "(call get_powers_dir first to get the path), then call reload. " +
      "Use disable/enable to toggle, lock/unlock to prevent auto-rewrite, delete to remove.",
    parameters: ManagePowerSchema,
    execute: async (
      _toolCallId: string,
      args: ManagePowerArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        switch (args.action) {
          case "get_powers_dir": {
            const dir = getWritablePowersDir();
            return text(`Write POWER.md files to: ${dir}\nStructure: ${dir}/<power-id>/POWER.md`);
          }

          case "reload": {
            reloadPowers();
            return text("Powers reloaded from disk.");
          }

          case "enable":
          case "disable": {
            if (!args.power_id) return text("Failed: power_id is required.");
            const { db } = await import("../../db/client.js");
            const { kaiPowers } = await import("../../db/schema/powers.js");
            const { eq } = await import("drizzle-orm");
            await db.update(kaiPowers)
              .set({ enabled: args.action === "enable", updatedAt: new Date() })
              .where(eq(kaiPowers.id, args.power_id));
            reloadPowers();
            return text(`Power "${args.power_id}" ${args.action}d.`);
          }

          case "lock":
          case "unlock": {
            if (!args.power_id) return text("Failed: power_id is required.");
            const { db } = await import("../../db/client.js");
            const { kaiPowers } = await import("../../db/schema/powers.js");
            const { eq } = await import("drizzle-orm");
            await db.update(kaiPowers)
              .set({ locked: args.action === "lock", updatedAt: new Date() })
              .where(eq(kaiPowers.id, args.power_id));
            reloadPowers();
            return text(`Power "${args.power_id}" ${args.action}ed.`);
          }

          case "delete": {
            if (!args.power_id) return text("Failed: power_id is required.");
            const deleted = await deletePower(args.power_id);
            if (!deleted) return text(`Failed: power "${args.power_id}" not found.`);
            return text(`Power "${args.power_id}" disabled.`);
          }

          default:
            return text(`Unknown action "${args.action}". Use: get_powers_dir, reload, enable, disable, lock, unlock, delete.`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return text(`Failed: ${msg}`);
      }
    },
  };
}
