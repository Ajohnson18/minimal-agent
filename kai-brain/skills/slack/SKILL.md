---
name: slack
description: Use AVA's Slack tools for Slack messaging/actions with parity APIs.
---

# Slack Tools

Use `slack_actions` for parity action APIs, and `slack_message` for upload-first workflows.

## slack_actions

### Send / edit / delete / read

```json
slack_actions(action: "sendMessage", to: "channel:C123", content: "Hello")
slack_actions(action: "editMessage", channelId: "C123", messageId: "1712023032.1234", content: "Updated")
slack_actions(action: "deleteMessage", channelId: "C123", messageId: "1712023032.1234")
slack_actions(action: "readMessages", channelId: "C123", limit: 20)
slack_actions(action: "readMessages", channelId: "C123", threadId: "1712023032.1234")
```

### Reactions

```json
slack_actions(action: "react", channelId: "C123", messageId: "1712023032.1234", emoji: "white_check_mark")
slack_actions(action: "react", channelId: "C123", messageId: "1712023032.1234", emoji: "white_check_mark", remove: true)
slack_actions(action: "react", channelId: "C123", messageId: "1712023032.1234", emoji: "")
slack_actions(action: "reactions", channelId: "C123", messageId: "1712023032.1234")
```

### Pins / member info / emoji list

```json
slack_actions(action: "pinMessage", channelId: "C123", messageId: "1712023032.1234")
slack_actions(action: "unpinMessage", channelId: "C123", messageId: "1712023032.1234")
slack_actions(action: "listPins", channelId: "C123")
slack_actions(action: "memberInfo", userId: "U123")
slack_actions(action: "emojiList", limit: 20)
```

## slack_message

Use `message`, `media`, `filePath`, `buffer`, or `content`.

```json
slack_message(target: "channel:C123", message: "Hello")
slack_message(target: "U123", media: "https://example.com/chart.png", message: "Latest chart")
slack_message(filePath: "/Users/you/report.csv", message: "Report")
slack_message(buffer: "<base64>", filename: "output.bin")
slack_message(content: "a,b\n1,2", filename: "data.csv")
```

## Tips

- Message context includes Slack message IDs and channels; reuse those directly.
- Emoji names should use Slack shortcodes without colons (`thumbsup`, `eyes`, `white_check_mark`).
- Use `threadId` with `slack_message` and `threadTs` with `slack_actions sendMessage` when explicit thread routing is needed.
