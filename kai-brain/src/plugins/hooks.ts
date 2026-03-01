import { createLogger } from "../lib/logger.js";
import type { HookPluginRegistration } from "./types.js";

const log = createLogger("hooks");

/**
 * Registry source for typed hook plugins.
 *
 * Hard-cut default: no legacy HOOK.md discovery. Hook plugins are registered
 * through code and loaded from this module.
 */
const STATIC_HOOK_PLUGINS: HookPluginRegistration[] = [];

export function getHookPlugins(): HookPluginRegistration[] {
  return [...STATIC_HOOK_PLUGINS];
}

export function registerHookPlugin(plugin: HookPluginRegistration): void {
  STATIC_HOOK_PLUGINS.push(plugin);
  log.info(
    {
      plugin: plugin.plugin,
      phase: plugin.phase,
      priority: plugin.priority ?? 0,
    },
    "Registered typed hook plugin",
  );
}
