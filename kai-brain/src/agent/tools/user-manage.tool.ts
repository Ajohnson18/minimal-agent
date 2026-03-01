import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import {
  getUserById,
  getUserIdentities,
  listCredentialKeys,
  setCredentialKey,
  deleteCredentialKey,
  linkIdentity,
  unlinkIdentity,
  updateUserConfig,
} from "../../services/user.service.js";
import type { UserRole } from "../../db/schema/users.js";

const UserManageSchema = Type.Object({
  action: Type.String({
    description:
      'Action: "whoami", "save_credential", "request_credential", "delete_credential", "list_credentials", "link_identity", "unlink_identity", "update_config"',
  }),
  key: Type.Optional(
    Type.String({
      description:
        "Credential key (for save/delete_credential, e.g. 'github_token', 'linear_api_key') or config key (for update_config, e.g. 'customInstructions', 'timezone')",
    }),
  ),
  value: Type.Optional(
    Type.String({
      description:
        "Credential value (for save_credential) or config value (for update_config). Use UPPER_SNAKE_CASE key names for credentials.",
    }),
  ),
  provider: Type.Optional(
    Type.String({
      description:
        'Identity provider for link_identity (e.g. "github", "linear", "notion", "cursor", "email")',
    }),
  ),
  externalId: Type.Optional(
    Type.String({
      description:
        "External ID for link_identity (e.g. GitHub username, email address)",
    }),
  ),
});

type UserManageArgs = Static<typeof UserManageSchema>;

export function createUserManageTool(context: {
  userId: string;
  userRole: UserRole;
}): ToolDefinition {
  return {
    name: "user_manage",
    label: "User Management",
    description: `Manage the current user's identity, credentials, and preferences.
Use this to:
- whoami: Show current user info, role, and linked identities
- save_credential: Store an API key/token securely (key + value). The credential is encrypted and auto-injected as an env var in all exec calls. Use UPPER_SNAKE_CASE keys (e.g. GITHUB_TOKEN, LINEAR_API_KEY). ALWAYS use this instead of writing secrets to files.
- request_credential: Show a secure input form to the user (key only, no value). Use when you need a credential from the user but don't have the value yet.
- delete_credential: Remove a stored credential by key
- list_credentials: List stored credential keys (not values)
- link_identity: Link an external account (provider + externalId, e.g. github/arman)
- unlink_identity: Remove a linked external account (provider + externalId)
- update_config: Update personal preferences (key + value, e.g. customInstructions, timezone)`,
    parameters: UserManageSchema,
    execute: async (
      _toolCallId: string,
      args: UserManageArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        switch (args.action) {
          case "whoami": {
            const user = await getUserById(context.userId);
            if (!user) return text("User not found.");
            const identities = await getUserIdentities(context.userId);
            const credKeys = await listCredentialKeys(context.userId);
            const idLines = identities.map((i) => `  ${i.provider}: ${i.externalId}`);
            const parts = [
              `Name: ${user.displayName || "(not set)"}`,
              `Role: ${user.role}`,
              `ID: ${user.id}`,
            ];
            if (idLines.length > 0) parts.push(`Identities:\n${idLines.join("\n")}`);
            if (credKeys.length > 0) parts.push(`Stored credentials: ${credKeys.join(", ")}`);
            return text(parts.join("\n"));
          }

          case "save_credential": {
            if (!args.key) return text("Error: key is required for save_credential.");
            if (!args.value) return text("Error: value is required for save_credential.");
            const credKey = args.key.toLowerCase();
            await setCredentialKey(context.userId, credKey, args.value);
            return text(`Credential "${credKey}" saved securely. It will be available as ${credKey.toUpperCase()} in all exec calls (including subagents). Do NOT write this value to any file.`);
          }

          case "request_credential": {
            if (!args.key) return text("Error: key is required for request_credential.");
            return text(`[CREDENTIAL_REQUEST:${args.key}] A secure input form has been shown to the user. Wait for them to submit the credential through the secure form.`);
          }

          case "delete_credential": {
            if (!args.key) return text("Error: key is required for delete_credential.");
            const deleted = await deleteCredentialKey(context.userId, args.key);
            return text(
              deleted
                ? `Credential "${args.key}" deleted.`
                : `Credential "${args.key}" not found.`,
            );
          }

          case "list_credentials": {
            const keys = await listCredentialKeys(context.userId);
            return text(
              keys.length > 0
                ? `Stored credentials: ${keys.join(", ")}`
                : "No credentials stored.",
            );
          }

          case "link_identity": {
            if (!args.provider) return text("Error: provider is required for link_identity.");
            if (!args.externalId) return text("Error: externalId is required for link_identity.");
            await linkIdentity(context.userId, args.provider, args.externalId);
            return text(`Linked ${args.provider} identity: ${args.externalId}`);
          }

          case "unlink_identity": {
            if (!args.provider) return text("Error: provider is required for unlink_identity.");
            if (!args.externalId) return text("Error: externalId is required for unlink_identity.");
            const unlinked = await unlinkIdentity(context.userId, args.provider, args.externalId);
            return text(
              unlinked
                ? `Unlinked ${args.provider} identity: ${args.externalId}`
                : `Identity ${args.provider}:${args.externalId} not found.`,
            );
          }

          case "update_config": {
            if (!args.key) return text("Error: key is required for update_config.");
            if (!args.value) return text("Error: value is required for update_config.");
            const VALID_CONFIG_KEYS = ["customInstructions", "timezone", "workspace"];
            if (!VALID_CONFIG_KEYS.includes(args.key)) {
              return text(
                `Unknown config key "${args.key}". Valid keys: ${VALID_CONFIG_KEYS.join(", ")}`,
              );
            }
            await updateUserConfig(context.userId, { [args.key]: args.value });
            return text(`Config "${args.key}" updated.`);
          }

          default:
            return text(
              `Unknown action: ${args.action}. Valid: whoami, save_credential, delete_credential, list_credentials, link_identity, unlink_identity, update_config`,
            );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return text(`User management error: ${msg}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
