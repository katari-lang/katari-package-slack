# slack — a Slack bot capability over Socket Mode

A single module, `slack`, plus its FFI sidecar `src/slack.ts`. The surface is two planes: **messages**
in and out (`watch_messages`, `send_message`, `try_send`) and **one interaction primitive** (`ask`) that
covers every human-in-the-loop shape. It is the Slack half of a twin contract with the **discord**
package — the same data types with the same fields, so a bot ports between them by swapping the import.

Socket Mode means **no public URL and no request-signature verification**: the sidecar opens an outbound
WebSocket with the app-level token and Slack pushes events over it, while the bot token drives the Web
API.

- `slack.provider(bot_source = ..., app_source = ...)` — connects ONCE and serves the client handle for
  the extent of the continuation.
- `slack.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  `slack.message` to your agent. Bot posts (this bot's own replies included) are not delivered, so
  replying cannot loop.
- `slack.send_message(channel, text, files ?= [], thread_ts ?= null)` — post to a channel, returning
  the posted message's `ts`; a message's `ts` as `thread_ts` replies in its thread, and `files` upload
  as attachments.
- `slack.try_send(channel, text, files ?= [], thread_ts ?= null)` — the resilient wrapper every bot
  writes: a blank text with no files posts nothing, a transient `api_error` drops just this post, and
  `auth_error` still re-raises.
- `slack.ask(channel, prompt, controls)` — post a prompt with controls and BLOCK until a member of the
  channel answers, returning the matching `answer`. The channel's membership is the trust boundary.

Posting files is `send_message(files = …)` — there is no second agent for it. Handing that to a model as
a tool with its own name and description is a **doc-on-let** in the app, not an alias in the library:

```katari
agent serve(channel: string) -> string {
  @"Tool: post images or documents to the channel, with a caption."
  let post_files = slack.send_message
  ai.complete(tools = [post_files], ...)
}
```

## The interaction plane

`ask` takes a list of `control`s and returns one `answer`. Both are plain data sums, so the four
human-in-the-loop shapes are four control lists rather than four agents:

| shape | controls | answer |
| --- | --- | --- |
| approval | two `button`s | `clicked(id, by)` |
| open question | a one-field `form` | `submitted(id, values, by)` |
| draft review | a `form` prefilled with the draft, beside a reject `button` | `submitted` / `clicked` |
| multiple choice | a `select` | `chose(id, option, by)` |

```katari
data button(id: string, label: string)
data select(id: string, label: string, options: array[string])
data field(id: string, label: string, value: string ?= "", multiline: boolean ?= false)
data form(id: string, label: string, title: string, fields: array[field])
type control = button | select | form

data clicked(id: string, by: string)
data chose(id: string, option: string, by: string)
data submitted(id: string, values: record[string], by: string)
type answer = clicked | chose | submitted
```

Every control is live at once and the **first** answer settles the ask; the controls are then stripped
from the message, so a second answer has nothing to press. Branch on the control's own `id`, never on
display text:

```katari
agent approve(channel: string, what: string) -> boolean {
  let answered = slack.ask(
    channel = channel,
    prompt = f"Approve: ${what}?",
    controls = [
      slack.button(id = "approve", label = "Approve"),
      slack.button(id = "deny", label = "Deny"),
    ],
  )
  match (answered) {
    case slack.clicked(id => "approve", by => _) -> { true }
    case _ -> { false }
  }
}
```

A `form` is a **two-stage** affair on Slack, because a dialog cannot be opened out of the blue: the form
posts as an ordinary button, and pressing it is what mints the three-second interaction token
(`trigger_id`) its dialog opens with. The submission then arrives over the same socket, correlated back
to the ask by the prompt's `ts`. Two consequences worth knowing:

- **Inputs are not validated, at all.** Every box is optional, a blank one comes back as `""`, and
  `submitted.values` is total over the form's declared fields — a `field` has no required-ness knob, so
  nothing here invents a check the program never asked for, and clearing a prefilled draft stays a
  legitimate edit. Nor *could* they be validated: the socket acknowledges every interaction the instant it
  arrives, which is exactly what closes a submitted dialog, so per-field errors can never be returned.
  Validate in the program and `ask` again.
- A dialog that cannot be opened (the token expired, a size cap was exceeded) raises `api_error`; catch
  it and ask again.

Opening a dialog and closing it again is **not** an answer: the question stays open and any control can
still answer it, so a curious press cannot consume the ask. Each control's `id` must be distinct within
one ask — the id is the correlation key Slack carries back.

`ask` holds no time limit by design: a deadline is `time.with_deadline` around it, a withdrawal is
`region.cancel_by_id` on the fiber holding it.

Slack's own size caps apply and are **not** checked here — an over-cap control is rejected by the
platform and surfaces as `api_error`: a button label or a select option is ≤75 characters, and a form's
`title` is ≤24. A form's own caps show when its **dialog opens**, not when the question posts.

`by` is the answerer's raw Slack user id (an opaque `U…` id, not a name). A workspace's ids are a small,
guessable space, so a plain digest is dictionary-reversible — tag it with `crypto.hmac_sha256` under a
secret key before letting it leave the program.

## Divergences from the discord twin

The two packages carry the same data types with the same fields. Everything that differs is here:

- **`message.thread`** — Slack's only extra field. Slack addresses a thread by its parent's `ts`, which
  is also a message's identity, so `send_message` returns a `ts` and takes `thread_ts`. Discord has no
  such value.
- **`form.title` is capped at 24 characters** — the tighter of the two platforms' caps, so a title that
  fits here fits Discord too (the reverse does not hold). Every other cap is each platform's own: Slack
  takes a ≤75-character button label and select option where Discord takes 80 and 100.
- **`slack_error` classification** — the same two constructors as Discord's `discord_error`, but
  classified from Slack's error strings (`invalid_auth`, `missing_scope`, …) rather than HTTP statuses.

Form validation is *not* on that list, and deliberately so: both sides make every input optional and both
return `values` total over the declared fields, with a blank box as `""`. Neither offers per-field
submission errors — Slack's cannot (the submission is already acknowledged by the time this package sees
it), and neither invents a check the `field` type has no knob for.

## Files and threads

Files are first-class on **both** directions: an incoming message's attachments arrive as `file` values
(downloaded with the bot token, since Slack file URLs are private), and outgoing `file` values upload
via `files.uploadV2`.

A delivered `message.thread` is the thread the message was posted in, or `null` for a top-level
message — pass it straight back as `send_message`'s `thread_ts` to reply where the message came from
(in its thread if it had one, in the channel otherwise).

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
   Mode delivers both the button presses and the dialog submissions over the same WebSocket, so no
   Request URL is needed here either.
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
agent echo(message: slack.message) -> null {
  match (message) {
    case slack.message(channel => channel, author => author, text => text, files => files, thread => thread) -> {
      slack.try_send(
        channel = channel,
        text = f"<@${author}> said: ${text}",
        files = files,
        thread_ts = thread,
      )
    }
  }
}

agent main() -> never {
  use slack.provider(
    bot_source = credentials.env(key = "SLACK_BOT_TOKEN"),
    app_source = credentials.env(key = "SLACK_APP_TOKEN"),
  )
  slack.watch_messages(channel = "C0123456789", deliver_to = echo)
}
```

Hand `slack.send_message` (or a doc-on-let rename of it) to an AI loop's tool list to let the model post
into the channel on its own.
