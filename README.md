# slack — a Slack bot capability over Socket Mode

A single module, `slack`, plus its FFI sidecar `src/slack.ts`: messages in and out (`watch_messages`,
`send_message`, `try_send`), and one interaction primitive (`ask`) covering every human-in-the-loop shape.
Socket Mode means no public URL and no request-signature verification — the sidecar opens an outbound
WebSocket with the app-level token and Slack pushes events over it, while the bot token drives the Web API.
Files are first-class both ways. It is the Slack half of a twin contract with the **discord** package: same
types, same fields, same argument names, so a bot ports between them by swapping the import.

- `slack.provider(bot_source, app_source)` — serves `slack.credential`, the workspace's two tokens, for the
  extent of the continuation. It connects nothing.
- `slack.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  `slack.message(id, channel, author, text, files, thread)` to your agent, whose argument is named `value`.
  Bot posts (this bot's own included) are not delivered, so replying cannot loop.
- `slack.list_messages(channel, after ?= "", limit ?= 50) -> array[message]` — the channel's own history
  after a message `ts`, in posted order, as the same `message` the watch delivers. Needs `channels:history`.
- `slack.send_message(channel, text, files ?= [], thread_ts ?= null) -> string` — post to a channel,
  returning the posted message's `ts`; a message's `ts` as `thread_ts` replies in its thread.
- `slack.try_send(channel, text, files ?= [], thread_ts ?= null) -> delivered | dropped(reason)` — the
  resilient wrapper: blank text with no files posts nothing, a transient `api_error` drops just this post,
  `auth_error` re-raises.
- `slack.ask(channel, prompt, controls) -> answer` — post a prompt with controls and block until a member of
  the channel answers. The channel's membership is the trust boundary.
- `slack.limits() -> caps`, `slack.check_controls(controls) -> valid | invalid(reason)` — Slack's numbers as
  data, and "is this question askable?" as a value. Both pure; check where the controls are built.

## Delivery and connections

Socket Mode delivers to open sockets. A running watch receives every event at least once — Slack re-sends
one whose acknowledgement was lost — and keeps no dedup memory, so a bot that must not act twice dedupes on
its own. Messages posted while no watcher is running sit outside that stream, in the channel's own history:
`list_messages` reads them back, so a bot keeps the `id` of the last message it handled somewhere durable
and reads forward from it.

Every call carries the tokens it acts with, and a connection belongs to the call that needs events, so it
ends when that call does. Re-forking a watcher after a runtime restart opens a fresh connection. The
interrupted call itself ends once, under the at-most-once rule, and whoever wanted that answer asks again.

## Failures

`slack.slack_error` is `auth_error(message)` or `api_error(message)`, raised as a `prelude.throw`, never a
panic.

- `auth_error` — the token is invalid, revoked, or missing a scope; an operator resolves it. A rotated token
  needs no restart: every call resolves the credential afresh.
- `api_error` — a rate limit, a transient fault, a channel the bot is not in, a payload over one of Slack's
  caps. Catch it to drop just that reply and keep serving.
- `env.missing_secret` / `oauth.server_error` surface from the provider's install site, on the first call
  that needs a token. A token that is present but bad surfaces from the call that used it.

Slack enforces every cap itself and this package clamps nothing, so an over-cap *or blank* string comes back
as `api_error`, and a form's own caps show when its dialog opens rather than when the question posts.

## The interaction plane

`ask` takes a list of `control`s and returns one `answer`, so the four human-in-the-loop shapes are four
control lists rather than four agents:

| shape | controls | answer |
| --- | --- | --- |
| approval | two `button`s | `clicked(id, by)` |
| open question | a one-field `form` | `submitted(id, values, by)` |
| draft review | a `form` prefilled with the draft, beside a reject `button` | `submitted` / `clicked` |
| multiple choice | a `select` | `chose(id, option, by)` |

Every control is live at once and the first answer settles the ask; the controls are then stripped from the
message. Branch on the control's own `id` — `case slack.clicked(id => "approve", by => _)` — never on
display text. Each control's `id` must be distinct within one ask: it is the correlation key Slack carries
back.

- A `form` is two-stage on Slack, because a dialog cannot be opened out of the blue: the form posts as an
  ordinary button, and pressing it mints the three-second interaction token its dialog opens with. So
  opening a dialog and closing it again is not an answer, and a dialog that cannot be opened is `api_error`.
- Every box of a `form` is optional and comes back as `""` when blank, so `submitted.values` is total over
  the declared fields. The socket acknowledges each interaction on arrival, which is what closes the dialog,
  so a submission carries no per-field errors: validate in the program and ask again.
- `by` on an answer, and `author` on a message, is a raw Slack user id (`U…`), drawn from a workspace's small
  and enumerable space. Pass one through the prelude's `crypto.pseudonym(key, value)`, resolving the key at
  the call site, before letting it leave the program.

## Divergences from the discord twin

`scripts/check-twin.mjs` (`pnpm test`) compares both modules' published names, data fields, agent arguments
and callback arguments. Anything that differs must be declared in the script with a reason, and those
declarations *are* the list — run it to print them, and after any change to either package's surface. Two
behaviours the identical types hide: Slack enforces its own caps and this package clamps nothing, where the
twin clamps a caption through `@discordjs/builders`; and a watch here is at-least-once while running, where
Discord's gateway acks only heartbeats and so can both drop and duplicate.

## Slack app setup

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) ("From scratch").
2. **Socket Mode**: Settings → Socket Mode → enable. Generate the app-level token with the
   `connections:write` scope — this is the `xapp-…` token (`SLACK_APP_TOKEN`).
3. **Scopes**: Features → OAuth & Permissions → Bot Token Scopes: `chat:write` (post), `files:write`
   (upload attachments), `files:read` (download incoming attachments), and `channels:history` for
   `list_messages` (`groups:history` for a private channel).
4. **Events**: Features → Event Subscriptions → enable, then under "Subscribe to bot events" add the message
   events for the conversations you watch: `message.channels`, `message.groups`, `message.im`. Socket Mode
   needs no Request URL.
5. **Interactivity** (only for `slack.ask`): Features → Interactivity & Shortcuts → toggle on. No Request
   URL here either.
6. Install to the workspace: OAuth & Permissions → Install. The Bot User OAuth Token is the `xoxb-…` token
   (`SLACK_BOT_TOKEN`).
7. Invite the bot to the channel (`/invite @your-bot`) and copy the channel id (the `C…` value).

## Secrets / env

- `SLACK_BOT_TOKEN` — the bot token (`xoxb-…`), for every Web API call and attachment download.
- `SLACK_APP_TOKEN` — the app-level token (`xapp-…`), only to open the Socket Mode connection:
  `watch_messages` and `ask` need one, and a bot that only posts never opens one at all.

Store both with `katari env set SLACK_BOT_TOKEN --secret` and `katari env set SLACK_APP_TOKEN --secret`.
Each is a `string of private`, which keeps a token out of a log, a store or an outbound message.

`src/slack.ts` imports `@slack/socket-mode`, `@slack/web-api` and `@katari-lang/port`, declared in
`package.json`; run `pnpm install` here so `katari apply` can bundle the sidecar.

## Usage

```katari
import slack

agent echo(value: slack.message) -> null {
  match (value) {
    case slack.message(id => _, channel => channel, author => author, text => text, files => files, thread => thread) -> {
      let _outcome = slack.try_send(
        channel = channel,
        text = f"<@${author}> said: ${text}",
        files = files,
        thread_ts = thread,
      )
      null
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
