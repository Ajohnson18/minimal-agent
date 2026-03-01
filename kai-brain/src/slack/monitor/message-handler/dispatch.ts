import {
  handleSlackMessage,
  storePendingMessage,
} from "../runtime.js";
import type { PreparedSlackMessage } from "./prepare.js";

export interface SlackMessageDispatchContract {
  dispatchPrepared: (prepared: PreparedSlackMessage) => Promise<void>;
}

export function createSlackMessageDispatch(): SlackMessageDispatchContract {
  return {
    dispatchPrepared: async (prepared) => {
      if (prepared.kind === "pending-history") {
        storePendingMessage(
          prepared.channelId,
          prepared.userId,
          prepared.text,
          prepared.messageTs,
        );
        return;
      }

      await handleSlackMessage(
        prepared.channelId,
        prepared.sessionKey,
        prepared.userId,
        prepared.text,
        prepared.messageTs,
        prepared.botUserId,
        prepared.files as Parameters<typeof handleSlackMessage>[6],
        prepared.attachments as Parameters<typeof handleSlackMessage>[7],
      );
    },
  };
}
