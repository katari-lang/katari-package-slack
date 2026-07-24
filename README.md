# slack — a Slack bot capability over Socket Mode

A single module, `slack`, plus its FFI sidecar `src/slack.ts`: watch a channel's messages and post
replies — threads and file attachments included — the Slack twin of the Discord package. Socket Mode
means **no public URL and no request-signature verification**: the sidecar opens an outbound WebSocket
with the app-level token and Slack pushes events over it, while the bot token drives the Web API.

- `slack.provider(bot_source = ..., app_source = ...)` — connects ONCE and serves the client handle for
  the extent of the continuation.
- `slack.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  message (`channel` / `author` / `text` / `thread_ts` / `files`) to your agent. Bot posts (this bot's
  own replies included) are not delivered, so replying cannot loop.
- `slack.send_message(channel, text, files ?= [], thread_ts ?= null)` — post to a channel, returning
  the posted message's `ts`; a message's `ts` as `thread_ts` replies in its thread, and `files` upload
  as attachments.
- `slack.try_send(channel, text, files ?= [], thread_ts ?= null)` — the resilient wrapper every bot
  writes: a blank text with no files posts nothing, a transient `api_error` drops just this post, and
  `auth_error` still re-raises.
- `slack.ask(channel, prompt, options)` — post a Block Kit button prompt and BLOCK until a member of
  the channel clicks, returning the clicked label. The channel's membership is the trust boundary.
- `slack.send_files(channel, files, caption)` — the tool shape of `send_message`, for handing to a model.

Files are first-class on **both** directions: an incoming message's attachments arrive as `file`
values (downloaded with the bot token, since Slack file URLs are private), and outgoing `file` values
upload via `files.uploadV2`.

Threads: a delivered `thread_ts` is the thread the message was posted in, or `null` for a top-level
message — pass it straight back to `send_message` to reply where the message came from (in its thread
if it had one, in the channel otherwise).

Delivery is at-least-once: every event is acknowledged on arrival (so a slow handler does not turn
into duplicates), but an acknowledgement lost to a dropped socket makes Slack re-send the event, and
no dedup memory is kept here.

## Slack app setup

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) ("From scratch").
2. **Socket Mode**: Settings → Socket Mode → enable it. Generate the app-level token with the
   `connections:write` scope — this is the `xapp-…` token (`SLACK_APP_TOKEN`).
3. **Scopes**: Features → OAuth & Permissions → Bot Token Scopes: add `chat:write` (post messages),
   `files:write` (upload attachments), `files:read` (download incoming attachments).
4. **Events**: Features → Event Subscriptions → enable, then under "Subscribe to bot events" add the
   message events for the conversations you watch: `message.channels` (public channels),
   `message.groups` (private channels), `message.im` (DMs). Socket Mode needs no Request URL.
5. **Interactivity** (only for `slack.ask`): Features → Interactivity & Shortcuts → toggle on. Socket
   Mode delivers the button clicks over the same WebSocket, so no Request URL is needed here either.
6. Install the app to your workspace: OAuth & Permissions → Install. The Bot User OAuth Token is the
   `xoxb-…` token (`SLACK_BOT_TOKEN`).
7. Invite the bot to the channel (`/invite @your-bot`) and copy the channel id (the `C…` value in the
   channel's details).

## Secrets / env

- `SLACK_BOT_TOKEN` — the bot token (`xoxb-…`), used for every Web API call and attachment download.
- `SLACK_APP_TOKEN` — the app-level token (`xapp-…`), used only to open the Socket Mode connection.

Store both in the runtime: `katari env set SLACK_BOT_TOKEN --secret` and
`katari env set SLACK_APP_TOKEN --secret`. Each is a `string of private`, passed straight to the
sidecar and never surfaced elsewhere.

## Sidecar dependencies

`src/slack.ts` imports `@slack/socket-mode`, `@slack/web-api` and `@katari-lang/port`. They are
declared in `package.json`; run `pnpm install` (or `npm install`) in this package so `katari apply`
can bundle the sidecar. (A pure-Katari consumer that never applies this package does not need them.)

## Usage

```katari
import slack

// Echo every message back where it came from (its thread if it had one), attachments included.
agent echo(channel: string, author: string, text: string, thread_ts: string | null, files: array[file]) -> null {
  slack.try_send(channel = channel, text = f"<@${author}> said: ${text}", files = files, thread_ts = thread_ts)
}

agent main() -> never {
  use slack.provider(
    bot_source = credentials.env(key = "SLACK_BOT_TOKEN"),
    app_source = credentials.env(key = "SLACK_APP_TOKEN"),
  )
  slack.watch_messages(channel = "C0123456789", deliver_to = echo)
}
```

Hand `slack.send_files` to an AI loop's tool list to let the model post images or documents on its
own.
