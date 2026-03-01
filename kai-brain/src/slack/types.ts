export type SlackFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  subtype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

export type SlackAttachment = {
  fallback?: string;
  text?: string;
  pretext?: string;
  author_name?: string;
  author_id?: string;
  from_url?: string;
  ts?: string;
  channel_name?: string;
  channel_id?: string;
  is_msg_unfurl?: boolean;
  is_share?: boolean;
  image_url?: string;
  image_width?: number;
  image_height?: number;
  thumb_url?: string;
  files?: SlackFile[];
  message_blocks?: unknown[];
};

export type SlackChannelType = "im" | "mpim" | "channel" | "group";

export type SlackMessageEvent = {
  type: "message";
  user?: string;
  bot_id?: string;
  subtype?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: SlackChannelType;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  message?: {
    ts?: string;
    thread_ts?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: SlackChannelType;
  };
  previous_message?: {
    ts?: string;
    thread_ts?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: SlackChannelType;
  };
};

export type SlackAppMentionEvent = {
  type: "app_mention";
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: SlackChannelType;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
};

export type SlackReactionEvent = {
  type: "reaction_added" | "reaction_removed";
  user?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  item_user?: string;
  event_ts?: string;
};

export type SlackEventCallbackEnvelope = {
  type: "event_callback";
  event:
    | SlackMessageEvent
    | SlackAppMentionEvent
    | SlackReactionEvent
    | Record<string, unknown>;
  authorizations?: Array<{ user_id?: string }>;
};

export type SlackUrlVerificationEnvelope = {
  type: "url_verification";
  challenge?: string;
};

export type SlackEventEnvelope =
  | SlackEventCallbackEnvelope
  | SlackUrlVerificationEnvelope
  | Record<string, unknown>;

export interface SlackInteractionPayload {
  type?: string;
  response_url?: string;
  trigger_id?: string;
  user?: { id?: string };
  container?: {
    channel_id?: string;
    message_ts?: string;
    thread_ts?: string;
  };
  message?: {
    ts?: string;
  };
  actions?: Array<{
    action_id?: string;
    value?: string;
  }>;
}

export interface SlackSlashCommandPayload {
  command?: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  response_url?: string;
}
