# slack — a Slack bot capability over Socket Mode

A single module, `slack`, plus its FFI sidecar `src/slack.ts`. The surface is two planes: **messages**
in and out (`watch_messages`, `send_message`, `try_send`) and **one interaction primitive** (`ask`) that
covers every human-in-the-loop shape. It is the Slack half of a twin contract with the **discord**
package — the same data types with the same fields, so a bot ports between them by swapping the import.

Socket Mode means **no public URL and no request-signature verification**: the sidecar opens an outbound
WebSocket with the app-level token and Slack pushes events over it, while the bot token drives the Web
API.

Every call carries the tokens it acts with, and nothing in a program points into the sidecar's memory
(0.5.0, breaking — see below). So a Socket Mode connection belongs to the CALL that needs events and dies
with it, which is what makes **re-forking a watcher after a runtime restart just work**.

- `slack.provider(bot_source = ..., app_source = ...)` — serves `slack.credential`, the workspace's two
  tokens, for the extent of the continuation. It connects nothing.
- `slack.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  `slack.message(id, channel, author, text, files, thread)` to your agent. Bot posts (this bot's own replies included) are not delivered, so
  replying cannot loop. The callback's own argument is named `value` (0.4.0). It opens the Socket Mode
  connection for its own lifetime, so it raises `slack_error` when that connection will not open (0.5.0).
- `slack.list_messages(channel, after ?= "", limit ?= 50) -> array[message]` — the channel's own history
  after a message `ts`, **in posted order** (0.6.0). Socket Mode's at-least-once holds only while the
  watch is RUNNING; a message posted while it is down is never delivered at all. So this is the other
  half of "miss nothing": keep the `id` of the last message you handled somewhere durable and read
  forward from it. Same `message` value the watch delivers — attachments downloaded, bot posts and
  non-message subtypes dropped — so one handler serves both paths. Needs `channels:history`.
- `slack.send_message(channel, text, files ?= [], thread_ts ?= null)` — post to a channel, returning
  the posted message's `ts`; a message's `ts` as `thread_ts` replies in its thread, and `files` upload
  as attachments.
- `slack.try_send(channel, text, files ?= [], thread_ts ?= null) -> delivered | dropped(reason)` — the
  resilient wrapper every bot writes: a blank text with no files posts nothing, a transient `api_error`
  drops just this post, and `auth_error` still re-raises. It **answers with the outcome** (0.4.0):
  dropping a post is right, dropping the *fact* of it is not.
- `slack.ask(channel, prompt, controls)` — post a prompt with controls and BLOCK until a member of the
  channel answers, returning the matching `answer`. The channel's membership is the trust boundary.
- `slack.limits() -> caps` — Slack's own numbers as data (**pure**), so a program reads a cap instead of
  rediscovering it from a rejected payload.
- `slack.check_controls(controls) -> valid | invalid(reason)` — is this question askable, as a **pure**
  value: every string, every count, and duplicate ids. Run it where the controls are built.
- `slack.fit_message(text, marker) -> string` — shorten text to fit one message, ending it with your own
  marker when anything was cut. **Pure**.
- `slack.author_tag(source, author, length ?= 8) -> string` — the keyed pseudonym for a speaker's `U…`
  id, so a user id can reach a model or a log without being a user id.

## New in 0.6.0 — a delivered message has an id, and the gap has a reader

`watch_messages` has always documented the hole in Socket Mode's at-least-once — a message posted while
the watch is down "is never delivered at all" — and told you that "a bot that must reconcile that gap
reads the channel's history itself". The package did not offer a way to do it, and a delivered message
carried no id to reconcile *from*. Both are fixed, on both twins at once:

- **`slack.message` grew an `id`** — the message's own `ts`, the same value `send_message` returns.
  (A top-level message's `id` is also the `thread` a reply to it would carry.) Additive: nothing in
  Katari constructs a `message`, so existing callbacks compile unchanged.
- **`slack.list_messages(channel, after, limit)`** reads forward from that `ts`, oldest first, one
  `conversations.history` call with no socket involved. `limit` is clamped into 1-200 (Slack's own
  recommendation), so a wide gap takes several calls; a SHORT answer is not proof the gap is closed
  (dropped bot posts and skipped subtypes shorten it too) — an EMPTY one is.
- It needs the **`channels:history`** scope (`groups:history` for a private channel), which watching a
  channel does not by itself grant. A missing scope is `auth_error`, as any other.

The filter, the shape and the attachment download are now written once in the sidecar and used by both
paths, so a reconciled message cannot quietly differ from a watched one.

## Breaking changes in 0.5.0

**The `connection` request is gone.** What the provider serves now is the workspace's two tokens:

```katari
data credential_data(bot_token: string of private, app_token: string of private)
request credential() -> credential_data
```

Renaming the row is the whole of the migration for a bot that goes through `send_message` / `try_send` /
`watch_messages` / `ask`, which is every bot — the low-level externals were never the interface:

| was | is |
| --- | --- |
| `with slack.connection \| io` | `with slack.credential \| io` |
| `slack.create_slack_client(bot_token = …, app_token = …)` | gone — there is nothing to create |
| `slack.slack_close(client = …)` | gone — there is nothing to close |
| `slack_send(client = …, …)` | `slack_send(bot_token = …, …)` |
| `slack_watch(client = …, …)` | `slack_watch(bot_token = …, app_token = …, …)` |
| `slack_ask(client = …, …)` | `slack_ask(bot_token = …, app_token = …, …)` |

**`watch_messages` raises `slack_error` now, and `provider` no longer does.** Opening the Socket Mode
connection was the provider's job and is now the job of the call that needs events, so that is where a bad
app-level token surfaces: `auth_error` from `watch_messages` or `ask` (`api_error` for a transient network
fault), and `env.missing_secret` / `oauth.server_error` still from the provider's install site but at the
first call that needs a token rather than at install. A bot that only posts never opens a socket at all, so
it never learns whether its app-level token is good.

**Why: a handle is not a durable value.** The provider used to connect once and serve the sidecar's opaque
handle for that connection. A durable program may hold only durable values, and a pointer into one
process's memory is not one — so a runtime restart replayed the program's committed state (recovery replays
committed effects instead of re-running them) into a fresh sidecar whose registry was empty, and every call
through the handle failed. Worse, the documented recovery — re-fork the watcher on `region.crashed` — handed
the new fiber the *same* dead handle, which made a silent crash loop out of a bot that was merely
disconnected. The fix is not to detect the staleness but to stop the pointer crossing the boundary: a call
takes what it needs to ACT (the remote name and the credential), and the sidecar may cache whatever it likes
keyed by those. Katari's data plane has always worked this way — `store` hands out a key, never a row
pointer — and `e2b` has always worked this way on the FFI plane (`e2b_run_in(session, code, api_key)`),
which is why e2b never had this bug. The twin made the same change in its 0.7.0.

### What a restart does now

A Socket Mode connection lives exactly as long as the call that needs it — shared by app-level token while
several calls want one, closed when the last of them ends — so:

- **A re-forked watcher connects.** `region.crashed` → fork the watcher again is a plain re-fork now: the
  fresh call opens a fresh connection. Nothing is stale, and there is no session to re-establish.
- **The interrupted call itself dies, once.** A watch or an ask in flight at the restart is interrupted
  under the at-most-once rule (a catchable panic). That is not fixable and is not meant to be: whoever
  wanted the answer asks again.
- **Everything durable is still there.** A `store` row, a desk's collected replies, a conversation — none
  of it was ever in the sidecar, and none of it is rebuilt by a replay.
- **The gap is a gap.** Socket Mode delivers to open sockets, so a message posted while no watcher is
  running is not delivered at all, and an open `ask`'s controls are left live in the channel (the
  interrupted call cannot tidy them). A bot that must reconcile the gap reads the channel's history itself.

Coming from 0.3.x, 0.4.0's three breaking changes still apply: `try_send` answers `delivered |
dropped(reason)` rather than `null` (dropping a post is right, dropping the *fact* of it is not — a caller
that genuinely does not care writes `let _outcome = slack.try_send(…)`), `watch_messages`'s `deliver_to` is
called with `value` rather than `message` (argument names are structural, and every other watch in the
ecosystem names its primary argument `value`), and `limits` / `check_controls` / `fit_message` /
`author_tag` arrived as pure agents this README had until then been *instructing* you to write by hand.

Posting files is `send_message(files = …)` — there is no second agent for it. Handing that to a model as
a tool with its own name and description is a **doc-on-let** in the app, not an alias in the library:

```katari
import slack
import ai
import ai.types

agent serve(ask: string) -> string with slack.credential | ai.infer_step | io | prelude.throw[ai.duplicate_tool | ai.step_error | slack.slack_error] {
  @"Tool: post images or documents to the channel, with a caption."
  let post_files = slack.send_message
  ai.infer_with_tools(
    history = [types.turn(role = types.user_role(), text = ask, files = [])],
    tools = [post_files],
    max_steps = 12,
  )
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
import slack

agent approve(channel: string, what: string) -> boolean with slack.credential | io | prelude.throw[slack.slack_error] {
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

**Every** ending takes the controls off, not just an answered one, so a question nobody is waiting on any
more is never left pressable:

| ending | line left in the channel |
| --- | --- |
| answered | `→ <outcome> (by <@who>)` |
| cancelled / deadline expired | `→ (expired)` |
| broken by the platform (a rejected dialog, a socket fault) | `→ (failed)` |

All three are the same edit, fire-and-forget and best-effort: no ending waits on a cosmetic post, and a
failed edit is swallowed rather than becoming the ask's outcome. **One** ending genuinely cannot tidy up — a
runtime restart, whose interrupted call takes the prompt's identity with it. A whole-run teardown used to be
the second (the provider's `finally` closed the client before the edit landed) and no longer is: the edit is
a plain Web API call and 0.5.0 leaves nothing to close underneath it.

### The caps, and checking a question before you ask it

Slack enforces every cap **itself**: this package renders a view as plain data and posts it, so nothing
is clamped locally and *everything* over a cap is fatal — an over-cap or blank label fails exactly as an
over-cap id does, arriving as a typed `api_error`. (Blank is fatal because a Block Kit `plain_text`
object takes at least one character.) A form's own caps show when its **dialog opens**, not when the
question posts.

`slack.limits()` publishes those numbers as data, and `slack.check_controls(controls)` reads them to
answer one question — *is this askable?* — as a **pure** value, with no connection:

```katari
import slack

data gate_unaskable(reason: string)
agent refuse_to_open_the_gate(why: string) -> never with prelude.throw[gate_unaskable] { prelude.throw(error = gate_unaskable(reason = why)) }

agent open_the_gate(channel: string, prompt: string) -> slack.answer with slack.credential | io | prelude.throw[slack.slack_error | gate_unaskable] {
  let controls = [slack.button(id = "approve", label = "Approve"), slack.button(id = "deny", label = "Deny")]
  match (slack.check_controls(controls = controls)) {
    case slack.valid() -> slack.ask(channel = channel, prompt = prompt, controls = controls)
    case slack.invalid(reason => reason) -> refuse_to_open_the_gate(why = reason)
  }
}
```

| `caps` field | value | what it bounds | source |
| --- | --- | --- | --- |
| `message_text` | 3000 | an `ask`'s `prompt` — a question posts as a **section block**, and Slack refuses a block past this | [section block](https://docs.slack.dev/reference/block-kit/blocks/section-block) |
| `post_text` | 40000 | `send_message` / `try_send`'s `text` — **truncated** past this, not refused; the one cap here that is not fatal | [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage) |
| `button_label` | 75 | `button.label`, and a `form`'s opening button | [button element](https://docs.slack.dev/reference/block-kit/block-elements/button-element) |
| `select_label` | 150 | `select.label`, the placeholder (blank is **not** legal) | [select menu element](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element) |
| `select_option` | 75 | each of `select.options`; the same string is also sent as the option's `value` (cap 150), so 75 binds | [option object](https://docs.slack.dev/reference/block-kit/composition-objects/option-object) |
| `select_options` | 100 | how many options one dropdown offers | [select menu element](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element) |
| `form_title` | 24 | `form.title` — the tightest number on either platform | [modal view](https://docs.slack.dev/reference/views/modal-views) |
| `form_fields` | 100 | boxes in one dialog; each is one input block and the dialog carries nothing else, so the view's block cap is the box cap | [modal view](https://docs.slack.dev/reference/views/modal-views) |
| `field_label` | 2000 | `field.label` | [input block](https://docs.slack.dev/reference/block-kit/blocks/input-block) |
| `field_value` | 3000 | `field.value`, the prefill (blank is legal — it is the absence of one) | **derived**, see below |
| `control_id` | 255 | `button` / `select` / `field` ids — the `action_id` Slack routes the answer back by | [button element](https://docs.slack.dev/reference/block-kit/block-elements/button-element) |
| `form_id` | 255 | `form.id` — both the opening button's `action_id` and the dialog's `callback_id`, capped alike | [modal view](https://docs.slack.dev/reference/views/modal-views) |
| `rows` | 1 | this package renders every control into **one** actions block, so a question has exactly one row | this package's renderer |
| `buttons_per_row` | 25 | that row's element cap. A dropdown does **not** take a row of its own here | [actions block](https://docs.slack.dev/reference/block-kit/blocks/actions-block) |

`field_value` is the one number Slack does not state: `initial_value` is documented with no cap, but a
plain-text input's own content bound is 3000 (its `max_length` accepts 1–3000), so a longer prefill
cannot survive the box it is put in. Treat it as the safest reading rather than a promise.

**Why there is no drift script for these numbers, unlike the twin's.** The discord package writes its
caps down *twice* — once in its sidecar next to the `@discordjs/builders` predicates that enforce them,
once in Katari — and `scripts/check-limits.mjs` fails when the copies disagree. Here `slack.ts` renders
raw Block Kit and validates nothing, and `@slack/web-api` ships no cap constants (its types carry the
shapes, not the bounds), so this package holds exactly **one** copy of each number and has nothing to
compare it against. The citations above are what keeps it honest; they were read on 2026-07-29, and a
number that moves at Slack moves here by hand. (The *twin* contract does have a script — see
*Divergences*.)

`check_controls` reports every string blank or over its cap, every count, an **empty** `controls` (which
Slack posts happily as a prompt nobody can answer, so the ask waits forever), and **duplicate ids**,
which nothing else catches usefully — two controls sharing an `action_id` cannot be told apart on the way
back, so a press on one would answer as the other, "deny" answering as "approve". It is deliberately not
wired into `ask`: `ask` returns an `answer` and has no room in that type for a verdict, so an internal
check could only *throw*, and what a failed check means is the caller's decision.

### Fitting text to a message

```katari
import slack

agent gate_prompt(headline: string, draft: string) -> string {
  let prompt = slack.fit_message(
    text = f"${headline}\n\n${draft}",
    marker = "\n… (cut to fit one Slack message — ask for the rest)",
  )
  prompt
}
```

The room is `message_text` **minus the marker's own length**, because the marker is posted too —
measuring the text, cutting it to the cap and appending afterwards is the way this is got wrong, and it
lands back over the cap every time. Text that already fits comes back unchanged, so it is safe to wrap
around everything.

It bounds against `message_text` (3000), not `post_text` (40000), deliberately on both counts: 3000 is
where a *prompt* actually fails, and it is the number the twin's single cap governs both planes with, so
text fitted here fits there. A plain `send_message` may legitimately carry more; bound that by
`post_text` yourself.

The marker is **yours** because only you know what the reader needs told, and something must be told:
text silently docked reads exactly like text that ended, and a model reading it will answer from a
fragment as though it had the whole. Write it as the fact ("the first 2,900 of 7,400 characters"), not
as a bare ellipsis.

The answered message and the `answer` name things differently, each for its reader: the line left in the
channel keeps the control's own `label` (for a `select`, the chosen option) and **mentions** the answerer,
while the `answer` carries the `id` the program chose and `by` as the raw user id. A human scrolling back
reads words and a name; the program gets keys it can branch on and correlate. So write a label as the audit
line someone reads months later — it is the half of the record a person actually reads.

### `author_tag` — the speaker, pseudonymised

`by` on an answer, and `author` on a message, is the raw Slack user id (an opaque `U…` id, not a name).
Pass it through `author_tag` before letting it leave the program:

```katari
import slack

agent tag_of(message: slack.message) -> string with io | prelude.throw[env.missing_secret | oauth.server_error] {
  let tag = slack.author_tag(source = credentials.env(key = "SLACK_BOT_TOKEN"), author = message.author)
  // → "5b31f5f5" — eight hex characters, stable per key, meaningless without it
  tag
}
```

`author_tag(source, author, length ?= 8)` is `crypto.hmac_sha256` under a **named** key, sliced to
`length` hex characters. Until 0.4.0 this README and the module's own docs *instructed* you to write
those twenty-five lines yourself, in two places — which is how it became clear the package should own
them.

- **Why not a plain hash.** A `U…` id looks opaque but is not drawn from an opaque space: a workspace
  holds some thousands of members at most, and any app with `users:read` — or anyone reading a mention in
  a public channel — can list them. `crypto.sha256` of one is therefore reversible by dictionary: hash
  the workspace's ids until one matches, and the pseudonym is an account again. An HMAC under a secret
  key has no such attack.
- **The key is a `credentials.source`**, not a value, so the secret never enters the app's dataflow. It
  resolves at every call (Katari's freshness rule — a rotated key lands without a restart, and rotating
  it rotates every pseudonym), which costs one credential read per tagged message. Any secret with a
  stable lifetime does; `SLACK_BOT_TOKEN` is the usual choice.
- **`length` is 1 to 64**, clamped into range. 8 hex characters is 32 bits: short enough to sit inline in
  a prompt or a log line, and it collides at around 2¹⁶ distinct speakers by the birthday bound. A
  program correlating across a large workspace carries the full 64 and *shows* the short one.
- **A pseudonym is not anonymity.** It is stable by construction, so it links everything one person ever
  said; what it removes is the ability to turn that link back into an account.
- **Tags do not carry across the twin** even under the same key — the two hash different id spaces — so
  one person on both platforms is two pseudonyms. That is the honest answer, not a defect.

## Divergences from the discord twin

**This is the one place the complete list lives.** The `discord` README points here, and so do both
modules' headers. It used to be written down three times — here, in the twin's README, and in
`slack.ktr`'s header — which by 2026-07 had produced three different lists (two divergences, five, and
six), none of them mentioning that `try_send` had changed shape on one side only. A list nothing checks
is a list that drifts.

So the list is a **machine**. `scripts/check-twin.mjs` (`pnpm test`) reads both modules and compares
every published name, every data field, every agent argument, and every callback's argument names.
Anything that differs must be *declared in the script, with a reason*, and the table below is that
script's output written out rather than a parallel copy of it. Run it after any change to either
surface:

```
$ pnpm test
the twin contract holds: 31 published name(s) on the slack side, 30 on the discord side,
12 declared divergence(s), 1 alias(es).
```

It fails when a name, a field, an argument or a callback's argument exists on one side and not the
other, when the shared members are ordered differently, and when a declared divergence no longer matches
anything (a stale note about a divergence that is gone). It skips with a notice when the twin is not
checked out beside this package; `KATARI_DISCORD_KTR` points it elsewhere.

### Shape — a program sees these at the type level

| divergence | side | why |
| --- | --- | --- |
| `message.thread`, `send_message.thread_ts`, `try_send.thread_ts` | slack | Slack addresses a thread by its parent's `ts`, which is also a message's identity. Discord has no such value, so there is nothing for the twin to carry. |
| `provider.bot_source` + `provider.app_source` vs `provider.source` | both | Slack genuinely takes two credentials (the `xoxb-…` Web API token and the `xapp-…` socket token); Discord's gateway takes one. |
| `credential_data` | slack | the resolved counterpart of the row above. Both twins serve the ambient credential as `request credential()`, but Slack's answer is a PAIR and a pair needs a name, so `credential()` here answers `credential_data(bot_token, app_token)` where the twin's answers the `string of private` itself. A program that only calls `send_message` / `watch_messages` / `ask` never sees the difference; one that performs `credential` directly reads two fields here and one string there. |
| `caps.post_text` | slack | Slack caps a *posted message's* text (40000, truncated) separately from a *block's* text (3000, fatal), so the two planes need two numbers. Discord's single 2000 governs both. |
| `message.display_name`, `clicked` / `chose` / `submitted`'s `display_name` | discord | `MESSAGE_CREATE` ships a partial guild member beside the author, so the nickname → global name → username chain costs Discord nothing. Slack's message event carries only the `U…` id, so the same field here would mean a `users.info` call per message plus the `users:read` scope. (Slack's *interaction* payloads do carry `user.username`, but that is the account handle, not the workspace display name, which lives in `profile.display_name` and still takes `users.info`.) A program that must read the same on both keeps its logic on `author` / `by`. |
| `slack_error` / `discord_error` | both | each package names its own failure sum and an app catches the one it imported; the two constructors under it are identical, classified from Slack's error strings here and from HTTP status there. |

Everything else is identical, by construction: the request `credential`, the data `message`, `button`,
`select`, `field`, `form`, `clicked`, `chose`, `submitted`, `delivered`, `dropped`, `caps`, `valid`,
`invalid`, and the agents `provider`, `send_message`, `try_send`, `watch_messages`, `ask`, `limits`,
`check_controls`, `fit_message` and `author_tag` — same names, same fields, same argument names, in the
same order.

### Behaviour — the types are identical and only the docs will tell you

- **A cap here is enforced by Slack; there it is clamped locally.** This package renders a view as plain
  data and posts it, so an over-cap *or blank* string comes back as a typed `api_error`. The Discord twin
  renders through `@discordjs/builders`, whose validators run inside its own sidecar, so it *clamps* a
  caption (a label, a title) with an ellipsis and substitutes a blank one with the control's own id
  rather than failing the question. Neither side can panic on a cap; only Discord will silently shorten
  one. So `check_controls` has two classes of report there (fatal and silent) and one here — everything
  is fatal.
- **Layout.** Every control here is one element of a single actions block: 25 of them, and a dropdown
  takes no row of its own. Discord packs buttons 5 to a row across 5 rows and gives each dropdown a row
  to itself. Same `caps` fields, genuinely different rules — read `rows` / `buttons_per_row` as a pair.
- **Delivery guarantee.** Slack acknowledges every event individually, and an acknowledgement lost to a
  dropped socket makes Slack re-send it, so `watch_messages` here is **at-least-once** *while the watch is
  running* (no dedup memory is kept, so a bot that must not act twice dedupes on its own). Discord's gateway
  has **neither** guarantee: it acks only heartbeats, so a reconnect can *drop* events (a non-resumable
  session re-identifies and Discord does not backfill) and can *duplicate* them (its sequence is persisted
  on arrival rather than on delivery, so a replay boundary can sit behind the delivery boundary). A Discord
  bot that cannot miss anything reconciles against the channel's history; the same code on Slack cannot
  miss, only repeat. **Both sides lose the gap**: each platform delivers to a live connection, and since
  0.5.0 / 0.7.0 a connection belongs to the watch call, so a message posted while no watcher is running was
  never delivered to anyone. That is not a divergence, and it is the reason the guarantee is written as a
  property of a running watch rather than of the bot.
- **The numbers.** Each platform's caps are its own. A control that must render identically on both is
  written to the **tighter of each pair**, which `pnpm test` prints as the *portable envelope* rather
  than leaving it to be copied by hand: `message_text` 2000, `button_label` 75, `select_option` 75,
  `select_options` 25, `form_title` 24, `form_fields` 5, `field_label` 45, `field_value` 3000,
  `control_id` 100, `form_id` 94.
- **A tag does not carry across.** `author_tag` under one key gives one person two different pseudonyms
  on the two platforms, because the id spaces are different.

Form validation is *not* on either list, and deliberately so: both sides make every input optional and
both return `values` total over the declared fields, with a blank box as `""`. Neither offers per-field
submission errors — Slack's cannot (the submission is already acknowledged by the time this package sees
it), and neither invents a check the `field` type has no knob for.

## Files and threads

Files are first-class on **both** directions: an incoming message's attachments arrive as `file` values
(downloaded with the bot token, since Slack file URLs are private), and outgoing `file` values upload
via `files.uploadV2`.

A delivered `message.thread` is the thread the message was posted in, or `null` for a top-level
message — pass it straight back as `send_message`'s `thread_ts` to reply where the message came from
(in its thread if it had one, in the channel otherwise).

Delivery is at-least-once while the watch is running: every event is acknowledged on arrival (so a slow
handler does not turn into duplicates), but an acknowledgement lost to a dropped socket makes Slack re-send
the event, and no dedup memory is kept here. A message that arrives while no watch is running — the gap
around a runtime restart — is not delivered at all, since Socket Mode delivers to open sockets.

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
- `SLACK_APP_TOKEN` — the app-level token (`xapp-…`), used only to open the Socket Mode connection:
  `watch_messages` and `ask` need one, and a bot that only posts never opens one at all.

Store both in the runtime: `katari env set SLACK_BOT_TOKEN --secret` and
`katari env set SLACK_APP_TOKEN --secret`. Each is a `string of private`, and since 0.5.0 the provider
serves both into the program under that taint — which is what keeps a token out of a log, a store or an
outbound message — for each call to hand to the sidecar.

## Sidecar dependencies

`src/slack.ts` imports `@slack/socket-mode`, `@slack/web-api` and `@katari-lang/port`. They are
declared in `package.json`; run `pnpm install` (or `npm install`) in this package so `katari apply`
can bundle the sidecar. (A pure-Katari consumer that never applies this package does not need them.)

Two checks live here:

- `pnpm run typecheck` — `tsc --noEmit` over the sidecar.
- `pnpm test` — `scripts/check-twin.mjs`, the twin contract (see *Divergences*). It needs the `discord`
  package checked out beside this one, as it is in the `katari-packages` tree, and skips with a notice
  otherwise. Run it on any change to either package's published surface.

## Usage

```katari
import slack

// Echo every message back where it came from (its thread if it had one), attachments included.
// The callback's argument is named `value`: that is what `watch_messages` calls it with.
agent echo(value: slack.message) -> null {
  match (value) {
    // Every field, including the `id` an echo does not need — a destructuring names the whole
    // shape, and leaving one out here would teach a `message` that has no identity to keep.
    case slack.message(id => _, channel => channel, author => author, text => text, files => files, thread => thread) -> {
      // `try_send` answers with its outcome. An echo has nobody to report to, so it drops the answer
      // deliberately — a bot that tells someone "posted" reads it instead.
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
