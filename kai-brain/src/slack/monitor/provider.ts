import type {
  SlackEventCallbackEnvelope,
  SlackEventEnvelope,
  SlackInteractionPayload,
  SlackSlashCommandPayload,
} from "../types.js";
import { handleSlackCommand } from "./commands.js";
import { createSlackMonitorContext } from "./context.js";
import { handleSlackInteractionEvent } from "./events/interactions.js";
import { handleSlackMessageEvents } from "./events/messages.js";
import {
  createSlackMessageHandler,
  type SlackMessageHandler,
} from "./message-handler.js";

export interface SlackMonitorProvider {
  handleEvent: (body: SlackEventEnvelope) => Promise<void>;
  handleInteraction: (payload: SlackInteractionPayload) => Promise<void>;
  handleCommand: (payload: SlackSlashCommandPayload) => Promise<void>;
}

function isEventCallbackEnvelope(value: SlackEventEnvelope): value is SlackEventCallbackEnvelope {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "event_callback" &&
    typeof (value as { event?: unknown }).event === "object"
  );
}

function createSlackMonitorProvider(): SlackMonitorProvider {
  const ctx = createSlackMonitorContext();
  const handleSlackMessage: SlackMessageHandler = createSlackMessageHandler({ ctx });

  return {
    handleEvent: async (body) => {
      if (!isEventCallbackEnvelope(body)) {
        return;
      }
      await handleSlackMessageEvents({
        ctx,
        body,
        handleSlackMessage,
      });
    },
    handleInteraction: async (payload) => {
      await handleSlackInteractionEvent({
        ctx,
        payload,
      });
    },
    handleCommand: async (payload) => {
      await handleSlackCommand(payload);
    },
  };
}

let providerSingleton: SlackMonitorProvider | null = null;

export function getSlackMonitorProvider(): SlackMonitorProvider {
  if (!providerSingleton) {
    providerSingleton = createSlackMonitorProvider();
  }
  return providerSingleton;
}

export function resetSlackMonitorProviderForTests(): void {
  providerSingleton = null;
}
