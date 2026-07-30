// The sidecar half of `slack.ktr` — the Socket Mode WebSocket plus the Web API client. Handlers
// register under this file's module path (`slack.*`).
//
// EVERY HANDLER TAKES THE TOKENS IT ACTS WITH, and nothing on the Katari side points into this process.
// That is the fix this file exists in the shape it does for: until 0.4.0 a connection was minted by
// `create_slack_client`, kept in a module-level map, and named by an opaque handle the program held — and
// a handle into one process's memory is not a durable value. A runtime restart replayed the program's
// committed state into a fresh sidecar with an empty map, so `connectionOf` threw on every call and
// re-forking the watcher handed the new fiber the same dead handle. What is kept here now is a CACHE
// KEYED BY THE TOKENS: a `WebClient` per bot token (an HTTP wrapper, so a pure optimization) and one
// shared Socket Mode connection per app-level token, held for exactly as long as the calls that need
// events and closed when the last of them ends. A restart leaves the cache empty, which is all that it
// means — the next call fills it, and the calls that were pointing at the old one are themselves gone.
//
// Files cross in both directions: an outgoing message's `file` values download over the blob side
// channel and upload to Slack (`files.uploadV2`); an incoming message's attachments download from
// Slack's authenticated file URL and upload over the same side channel, so the delivered message
// carries real `file` values.
//
// The interaction plane (`slack_ask`) is a two-stage affair on Slack, because a dialog cannot be opened
// out of the blue: a `form` control posts as a plain BUTTON, and the `block_actions` envelope that
// button's press produces carries the three-second `trigger_id` that `views.open` needs. The dialog's
// submission then arrives as a `view_submission` on the same `interactive` socket event, correlated back
// to its ask by the prompt's `ts` in `private_metadata`.

import { Buffer } from "node:buffer";
import {
  katari,
  KatariCancelledError,
  KatariData,
  type KatariAgent,
  type KatariFile,
  type KatariRecord,
  KatariString,
  type KatariText,
  KatariThrowError,
  type KatariValue,
} from "@katari-lang/port";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

/** Read a property off an unknown value without asserting its shape. */
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The values of an unknown object (or the elements of an array) as `unknown[]`, empty for anything
 *  else — for walking an untyped JSON structure without asserting its shape. */
function objectValues(value: unknown): unknown[] {
  return typeof value === "object" && value !== null ? Object.values(value) : [];
}

/** Slack error codes that mean the credential itself is unusable — the operator must fix the token or
 *  scopes; the bot cannot recover on its own. Everything else is classified as a (usually transient or
 *  per-message) `api_error`. */
const SLACK_AUTH_CODES = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "ekm_access_denied",
]);

/** The Slack platform error code out of a failed Web API call (`chat.postMessage` / `files.uploadV2` /
 *  `views.open` reject with a `WebAPICallError` whose `data.error` is the code, e.g. "invalid_auth"), or
 *  undefined when the failure carries none (a transport fault). */
function slackErrorCode(error: unknown): string | undefined {
  const code = property(property(error, "data"), "error");
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** The human-readable message for a `slack_error` payload: the platform code, else the JS message. */
function slackErrorMessage(error: unknown): string {
  const code = slackErrorCode(error);
  if (code !== undefined) return code;
  const message = property(error, "message");
  if (typeof message === "string" && message.length > 0) return message;
  return String(error);
}

/** The qualified `slack_error` constructor for a failure: an unusable credential is `auth_error`,
 *  everything else (rate limit, transport, a per-channel refusal, a Block Kit payload over one of
 *  Slack's size caps) is `api_error`. */
function slackErrorConstructor(error: unknown): string {
  const code = slackErrorCode(error);
  return code !== undefined && SLACK_AUTH_CODES.has(code) ? "slack.auth_error" : "slack.api_error";
}

/** The Web API client for a bot token. A `WebClient` opens nothing — it is an HTTP wrapper around the
 *  token — so keeping one per token is a pure optimization no caller can observe: a miss costs a
 *  constructor, never a reconnect, and an empty map after a restart is indistinguishable from a full one. */
const webClients = new Map<string, WebClient>();

function webClientFor(botToken: string): WebClient {
  const cached = webClients.get(botToken);
  if (cached !== undefined) return cached;
  const web = new WebClient(botToken);
  webClients.set(botToken, web);
  return web;
}

/** One Socket Mode connection, shared by every live call that wants events on the same app-level token.
 *  Sharing is a CORRECTNESS requirement rather than a saving: Slack round-robins each event across every
 *  socket open on an app token, so two sockets would split one channel's traffic between two watchers and
 *  each would silently miss half of it. */
interface SharedSocket {
  appToken: string;
  socket: SocketModeClient;
  /** The one `start()`, awaited by every leaseholder — whoever opened the socket and whoever joined while
   *  it was still connecting fail together on a bad app-level token. */
  started: Promise<void>;
  /** How many live calls hold it. The socket closes at zero: a watch that ended, an ask that was answered
   *  or cancelled. Nothing durable counts here — a restart takes the leases and the socket together. */
  leases: number;
}

const sharedSockets = new Map<string, SharedSocket>();

/** Lease the shared socket for an app-level token, opening one if this is the first caller. It comes back
 *  BEFORE it has connected, deliberately: that lets a caller whose events start arriving the moment the
 *  connection is up — a watch — attach its listener synchronously and await `started` only after, so
 *  nothing arrives in the gap between the two. (The 0.4.0 shape connected at provider-install time and
 *  attached a listener whenever a watch happened to start, and every event in between was acknowledged and
 *  dropped.) An `ask` has no such gap to close: its own prompt does not exist until the connection is up. */
function acquireSocket(appToken: string): SharedSocket {
  const existing = sharedSockets.get(appToken);
  if (existing !== undefined) {
    existing.leases += 1;
    return existing;
  }
  const socket = new SocketModeClient({ appToken });
  // Acknowledge every envelope the moment it arrives, independently of any watcher: Slack re-sends an
  // event not acked within a few seconds, and a delivery into the runtime can take arbitrarily long, so
  // acking from the delivery path would turn every slow handler into duplicates. A failed ack (the socket
  // dropped mid-reply) is deliberately ignored — Slack just re-sends the envelope, which is the
  // at-least-once contract the watch documents.
  //
  // The empty ack is also what an interaction needs: a `block_actions` wants nothing back, and an empty
  // ack of a `view_submission` is exactly what CLOSES the submitted dialog. It is the reason a form's
  // inputs cannot be rejected with per-field errors — the envelope is already answered by the time this
  // package sees it, which `ask` documents as the contract.
  socket.on("slack_event", ({ ack }: { ack: () => Promise<void> }) => {
    void ack().catch(() => {});
  });
  const shared: SharedSocket = {
    appToken,
    socket,
    started: socket.start().then(() => undefined),
    leases: 1,
  };
  // A connect that failed leaves nothing to reuse, so the entry goes: the next call opens a fresh socket
  // instead of awaiting a promise that will never resolve. Identity-checked, so a later call's own socket
  // is never evicted, and every leaseholder still learns of the failure through its own `started`.
  void shared.started.catch(() => {
    if (sharedSockets.get(appToken) === shared) sharedSockets.delete(appToken);
  });
  sharedSockets.set(appToken, shared);
  return shared;
}

/** Give up one lease; the last one out closes the socket. A socket left open keeps receiving events, and
 *  Slack round-robins each event across every socket open on the app token, so an abandoned socket would
 *  swallow (acknowledge) messages a live bot then never sees — the hazard the old package armed a `finally`
 *  around the whole RUN for. Ending with the last CALL is the same guarantee with a lifetime a restart
 *  cannot outlive. Lingering instead (holding it briefly in case another call wants it) would be a timer
 *  bought with a connection nobody is using, so the close is immediate and a re-fork pays a fresh connect. */
function releaseSocket(shared: SharedSocket): void {
  shared.leases -= 1;
  if (shared.leases > 0) return;
  if (sharedSockets.get(shared.appToken) === shared) sharedSockets.delete(shared.appToken);
  // `disconnect` ends the Socket Mode session — the SDK's documented shutdown: it stops reconnecting and
  // closes the WebSocket. It runs however `started` SETTLED, and only once it has: a connect still in
  // flight would race it (the SDK resolves a disconnect that finds no socket yet and then connects
  // anyway), while a connect that FAILED after its WebSocket had opened leaves the SDK's own reconnect
  // timer armed — an orphan that would keep stealing and acknowledging this app's events. Neither
  // failure is anyone's to act on. The Web API client holds no connection, so nothing to release there.
  void shared.started
    .catch(() => {})
    .then(() => shared.socket.disconnect())
    .catch(() => {});
}

/** A filename for an attachment payload: Slack requires one; derive the extension from the MIME type
 *  so an image previews inline instead of downloading as a generic binary. */
function attachmentName(contentType: string | undefined, index: number): string {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  const extension = (contentType !== undefined ? extensions[contentType] : undefined) ?? "bin";
  return `file-${index + 1}.${extension}`;
}

/** The `ts` of the message a `files.uploadV2` shared into its channel — the seam a later thread-reply
 *  addresses the upload by, symmetric with a plain post's own `ts`. `uploadV2` returns
 *  `{ ok, files: [ completeUploadExternal-response, … ] }`, and a File shared into a channel records
 *  the share's message `ts` under `shares.public` (or `shares.private` for a private channel), keyed by
 *  channel id. Best-effort: `undefined` when Slack reports no share (a silent upload, an unexpected
 *  response shape), which the caller renders as `""`. */
function firstShareTs(response: unknown): string | undefined {
  for (const job of objectValues(property(response, "files"))) {
    for (const fileEntry of objectValues(property(job, "files"))) {
      const shares = property(fileEntry, "shares");
      for (const visibility of ["public", "private"]) {
        for (const channelShares of objectValues(property(shares, visibility))) {
          const shareList: unknown[] = Array.isArray(channelShares) ? channelShares : [];
          const ts = property(shareList[0], "ts");
          if (typeof ts === "string" && ts.length > 0) return ts;
        }
      }
    }
  }
  return undefined;
}

/** What this sidecar reads out of a Socket Mode `message` envelope (the SDK emits it untyped). Every
 *  field is optional because the events API varies by subtype; the listener filters to the shapes it
 *  understands before delivering. */
interface MessageEnvelope {
  event: {
    channel?: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    subtype?: string;
    bot_id?: string;
    files?: Array<{ url_private_download?: string; url_private?: string; mimetype?: string }>;
  };
}

// ─── reading the argument's data values ───────────────────────────────────────────────────────────

/** A bare record, as a decoded `data` value's fields always are. A predicate rather than a cast, so the
 *  narrowing is the compiler's. */
function isRecord(value: unknown): value is KatariRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a `data` value in the argument. The katari-side type guarantees a data value here, so
 *  the empty fallback exists only to satisfy the type — a well-typed call never takes it. */
function dataFields(value: KatariValue): KatariRecord {
  if (!(value instanceof KatariData)) return {};
  return isRecord(value.value) ? value.value : {};
}

/** A katari `string` field, whether it arrived inline or blob-backed. Every string a control carries can
 *  be large — a draft-editing form's prefill is exactly the case the runtime promotes out of line — so
 *  none of them may be read as a plain JS string. */
async function readText(value: KatariValue): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof KatariString) return value.text();
  return "";
}

/** A katari `array` field's elements. */
function readArray(value: KatariValue): KatariValue[] {
  return Array.isArray(value) ? value : [];
}

// ─── the interaction plane: controls in, one answer out ───────────────────────────────────────────

/** One control an ask offered, read out of its `KatariData` — the shape both the Block Kit builder and
 *  the answer matcher work from. The `id` is the action_id Slack echoes back, so it is the key an
 *  interaction is resolved to its control by. */
type Control = ButtonControl | SelectControl | FormControl;

interface ButtonControl {
  kind: "button";
  id: string;
  label: string;
}
interface SelectControl {
  kind: "select";
  id: string;
  label: string;
  options: string[];
}
interface FormControl {
  kind: "form";
  id: string;
  label: string;
  title: string;
  fields: FormField[];
}
interface FormField {
  id: string;
  label: string;
  value: string;
  multiline: boolean;
}

async function readControl(control: KatariData<KatariRecord>): Promise<Control> {
  const fields = control.value;
  switch (control.name) {
    case "slack.button":
      return {
        kind: "button",
        id: await readText(fields.id),
        label: await readText(fields.label),
      };
    case "slack.select":
      return {
        kind: "select",
        id: await readText(fields.id),
        label: await readText(fields.label),
        options: await Promise.all(readArray(fields.options).map(readText)),
      };
    case "slack.form":
      return {
        kind: "form",
        id: await readText(fields.id),
        label: await readText(fields.label),
        title: await readText(fields.title),
        fields: await Promise.all(readArray(fields.fields).map(readFormField)),
      };
    default:
      // `control` is a closed sum of exactly three constructors, so a fourth is a defect rather than a
      // runtime condition: fail loudly instead of silently dropping a control a human would look for.
      throw new Error(`unknown slack control: ${control.name}`);
  }
}

async function readFormField(value: KatariValue): Promise<FormField> {
  const fields = dataFields(value);
  return {
    id: await readText(fields.id),
    label: await readText(fields.label),
    value: await readText(fields.value),
    multiline: fields.multiline === true,
  };
}

/** The minimal Block Kit shapes this sidecar posts. The Web API types its `blocks` argument as an open
 *  union whose base member is `{ type: string }`, so these structural literals satisfy it without
 *  importing the (transitive, un-hoisted) `@slack/types` package. */
interface PlainText {
  type: "plain_text";
  text: string;
}
interface Mrkdwn {
  type: "mrkdwn";
  text: string;
}
interface SectionBlock {
  type: "section";
  text: Mrkdwn;
}
interface ButtonElement {
  type: "button";
  text: PlainText;
  action_id: string;
}
interface SelectElement {
  type: "static_select";
  action_id: string;
  placeholder: PlainText;
  options: Array<{ text: PlainText; value: string }>;
}
interface ActionsBlock {
  type: "actions";
  elements: Array<ButtonElement | SelectElement>;
}
type MessageBlock = SectionBlock | ActionsBlock;

/** A dialog's input row: one `plain_text_input` under its label. `block_id` and `action_id` are both the
 *  `field`'s own id, so the submission's state map is keyed by exactly what the katari side declared.
 *  Always `optional` — a `field` carries no required-ness knob, so requiring one here would be validation
 *  this package invented and no program asked for; emptying a prefilled draft is a legitimate edit. */
interface InputBlock {
  type: "input";
  block_id: string;
  optional: true;
  label: PlainText;
  element: {
    type: "plain_text_input";
    action_id: string;
    multiline: boolean;
    initial_value?: string;
  };
}

/** The modal a `form` opens. `submit` is required whenever the view carries an input block. */
interface ModalView {
  type: "modal";
  callback_id: string;
  private_metadata: string;
  title: PlainText;
  submit: PlainText;
  close: PlainText;
  blocks: InputBlock[];
}

/** What this sidecar reads out of a Socket Mode `interactive` envelope's payload: a `block_actions` from
 *  a press or a choice, and a `view_submission` from a submitted dialog. Every field is optional because
 *  the SDK emits it untyped; the listener filters to the ask it is waiting for before use. */
interface InteractionPayload {
  type?: string;
  trigger_id?: string;
  user?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ action_id?: string; selected_option?: { value?: string } }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: { [blockId: string]: { [actionId: string]: { value?: string | null } } } };
  };
}

/** The prompt message: the question, then every control in one actions row. */
function promptBlocks(prompt: string, controls: Control[]): MessageBlock[] {
  const blocks: MessageBlock[] = [{ type: "section", text: { type: "mrkdwn", text: prompt } }];
  const elements = controls.map(controlElement);
  // An actions block must carry at least one element, so an ask offering no controls posts as plain text
  // (and then waits forever — which is what asking with no way to answer means).
  if (elements.length > 0) blocks.push({ type: "actions", elements });
  return blocks;
}

function controlElement(control: Control): ButtonElement | SelectElement {
  switch (control.kind) {
    case "select":
      return {
        type: "static_select",
        action_id: control.id,
        placeholder: { type: "plain_text", text: control.label },
        options: control.options.map((option) => ({
          text: { type: "plain_text", text: option },
          value: option,
        })),
      };
    // A form's channel-side control is an ordinary button: pressing it is the only way to mint the
    // interaction token its dialog opens with.
    case "button":
    case "form":
      return {
        type: "button",
        text: { type: "plain_text", text: control.label },
        action_id: control.id,
      };
  }
}

function modalView(control: FormControl, askTs: string): ModalView {
  return {
    type: "modal",
    // The two halves of the correlation, both authored here and echoed back verbatim on the submission:
    // `callback_id` says WHICH form was submitted, `private_metadata` says which ASK is waiting for it.
    // The pair is what lets several asks — each with several forms — be open in one channel at once.
    callback_id: control.id,
    private_metadata: askTs,
    title: { type: "plain_text", text: control.title },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: control.fields.map(
      (field): InputBlock => ({
        type: "input",
        block_id: field.id,
        // Slack's input blocks default to REQUIRED; a `field` has no knob for that, so opting every one
        // out is what keeps `values` total over the declared fields — a blank box submits as "".
        optional: true,
        label: { type: "plain_text", text: field.label },
        element: {
          type: "plain_text_input",
          action_id: field.id,
          multiline: field.multiline,
          // An empty prefill is omitted rather than sent as "": the rendered input is the same either
          // way, and omitting keeps the payload the shape Slack's reference describes.
          ...(field.value === "" ? {} : { initial_value: field.value }),
        },
      }),
    ),
  };
}

/** A submitted dialog's inputs, keyed by ACTION id — the `field`'s own id. Slack may substitute its own
 *  `block_id`s, so the action id is the only key the katari side can rely on. */
function submittedValues(view: NonNullable<InteractionPayload["view"]>): Record<string, string> {
  const submitted: Record<string, string> = {};
  for (const block of Object.values(view.state?.values ?? {})) {
    for (const [actionId, element] of Object.entries(block)) {
      submitted[actionId] = element.value ?? "";
    }
  }
  return submitted;
}

/** One settled ask: the `answer` data value the katari side receives, and the one-line record left in
 *  the channel once the controls come off. */
interface Answered {
  answer: KatariData;
  receipt: string;
}

/** Replace the prompt's controls with @outcome@, a one-line record of how the ask ended. EVERY ending goes
 *  through here — an answer (its receipt), a cancel (`(expired)`), a platform failure (`(failed)`) — because
 *  a question nobody is waiting on any more must not keep controls a member can still press: pressing a dead
 *  control shows Slack's own interaction failure, which reads as a broken bot. One `chat.update` call site,
 *  so the three endings cannot drift apart.
 *
 *  FIRE AND FORGET, and it swallows its own failures: no ending may be delayed by a cosmetic edit, nor broken
 *  by one. Losing a human's decision to a failed `chat.update` would be far worse than a prompt left looking
 *  live, and a cancel least of all should wait on Slack. The record is a fixed one-liner rather than an echo
 *  of what was submitted — a form's text is unbounded and would blow the block's own size cap, and what to
 *  post back is the program's decision, not this package's. */
function stripControls(
  web: WebClient,
  channel: string,
  askTs: string,
  question: string,
  outcome: string,
): void {
  const text = `${question}\n→ ${outcome}`;
  const stripped: MessageBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  void web.chat.update({ channel, ts: askTs, text, blocks: stripped }).catch(() => {});
}

/** The " (by <@U…>)" suffix on the channel's record, empty when Slack reported no user. */
function answeredBy(userId: string): string {
  return userId === "" ? "" : ` (by <@${userId}>)`;
}

/** Wait for the first answer to the prompt at `askTs`. Presses and choices answer directly; a form's
 *  press only opens its dialog, and the answer is the `view_submission` that follows. */
function awaitAnswer(
  socket: SocketModeClient,
  web: WebClient,
  controls: Control[],
  askTs: string,
  signal: AbortSignal,
): Promise<Answered> {
  const offered = new Map(controls.map((control) => [control.id, control]));
  return new Promise<Answered>((resolve, reject) => {
    // An `abort` listener on an already-aborted signal never fires, so a call cancelled before the wait
    // began has to settle here or it would hang forever. Nothing is registered yet, so nothing to clean up.
    if (signal.aborted) {
      reject(new KatariCancelledError());
      return;
    }
    const listener = (interactiveEvent: { body: InteractionPayload }) => {
      const payload = interactiveEvent.body;
      if (payload.type === "block_actions") {
        // Only an interaction on THIS prompt: filtering by the posted message's ts is what keeps two
        // asks open in the same channel from cross-answering.
        if (payload.message?.ts !== askTs) return;
        const action = payload.actions?.[0];
        const control = action?.action_id === undefined ? undefined : offered.get(action.action_id);
        if (action === undefined || control === undefined) return;
        const by = payload.user?.id ?? "";
        switch (control.kind) {
          case "button":
            settle({
              answer: new KatariData("slack.clicked", { id: control.id, by }),
              receipt: `${control.label}${answeredBy(by)}`,
            });
            return;
          case "select": {
            const option = action.selected_option?.value;
            // A static select reports its choice inline; a payload without one is not an answer.
            if (option === undefined) return;
            settle({
              answer: new KatariData("slack.chose", { id: control.id, option, by }),
              receipt: `${control.label}: ${option}${answeredBy(by)}`,
            });
            return;
          }
          case "form": {
            const triggerId = payload.trigger_id;
            if (triggerId === undefined) {
              fail(new Error("slack block_actions carried no trigger_id, so the form cannot open"));
              return;
            }
            // The press is not the answer — it is the only source of the three-second interaction token
            // a dialog opens with. Keep listening: the answer is this dialog's submission. A failed open
            // fails the ask, because the human pressed and no answer can now arrive through that control.
            void web.views.open({ trigger_id: triggerId, view: modalView(control, askTs) }).catch(fail);
            return;
          }
        }
      }
      const view = payload.view;
      // A dialog was submitted. `private_metadata` carries the prompt's ts, so this is the same
      // correlation the press used, handed through the dialog and back.
      if (payload.type === "view_submission" && view !== undefined && view.private_metadata === askTs) {
        const id = view.callback_id ?? "";
        const by = payload.user?.id ?? "";
        settle({
          answer: new KatariData("slack.submitted", { id, values: submittedValues(view), by }),
          receipt: `${offered.get(id)?.label ?? id} submitted${answeredBy(by)}`,
        });
      }
    };
    const cleanup = () => {
      socket.off("interactive", listener);
      signal.removeEventListener("abort", abort);
    };
    const settle = (answered: Answered) => {
      cleanup();
      resolve(answered);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    // The runtime cancelled the call (an expired `time.with_deadline`, a cancelled fiber, teardown): stop
    // listening and settle. `fail` runs `cleanup`, so the socket listener and the abort listener both come
    // off here — the ask holds no state anywhere else, so a cancelled ask leaks nothing. The caller strips
    // the now-dead controls off the message. `KatariCancelledError` is the port's own expected-cancellation
    // reply: any other rejection while aborted still confirms the cancel, but logs a diagnostic with it,
    // and a deadline-wrapped ask is the RECOMMENDED shape — so its ordinary expiry must be silent.
    const abort = () => fail(new KatariCancelledError());
    socket.on("interactive", listener);
    signal.addEventListener("abort", abort);
  });
}

katari.agent<{
  bot_token: string;
  channel: string;
  text: string;
  thread_ts: string | null;
  files: KatariFile[];
}>("slack_send", async ({ bot_token, channel, text, thread_ts, files }) => {
  // A post is pure Web API: the bot token is the whole of what it takes to act, so this opens no socket
  // and a post made after a restart is indistinguishable from the first one. Only the Slack calls below
  // can fail, and each becomes a catchable `slack_error`.
  const web = webClientFor(bot_token);
  try {
    if (files.length === 0) {
      const response = await web.chat.postMessage({
        channel,
        text,
        ...(thread_ts === null ? {} : { thread_ts }),
      });
      // The posted message's `ts` — the seam a later thread-reply / edit addresses it by. A successful
      // post always carries one; `?? ""` only guards the type.
      return response.ts ?? "";
    }
    // Each file's bytes come over the blob side channel; Slack's upload wants a Buffer + a filename. The
    // slim handle carries no metadata, so the MIME type rides in with the same download. `uploadV2`
    // shares every file into the channel in one post, with the text as its caption (`initial_comment`).
    const uploads = await Promise.all(
      files.map(async (file, index) => ({
        file: Buffer.from(await file.bytes()),
        filename: attachmentName(await file.contentType(), index),
      })),
    );
    // The two calls differ only in `thread_ts`, but the SDK types the thread destination as requiring
    // it and the channel destination as forbidding it, so the branch keeps both object literals honest.
    // `uploadV2` returns the file shares rather than a message, so the share's `ts` is dug out for the
    // same thread-reply seam the plain-post path returns.
    if (thread_ts === null) {
      const response = await web.files.uploadV2({
        channel_id: channel,
        ...(text === "" ? {} : { initial_comment: text }),
        file_uploads: uploads,
      });
      return firstShareTs(response) ?? "";
    }
    const response = await web.files.uploadV2({
      channel_id: channel,
      thread_ts,
      ...(text === "" ? {} : { initial_comment: text }),
      file_uploads: uploads,
    });
    return firstShareTs(response) ?? "";
  } catch (error) {
    // Raise the execution failure as the declared `prelude.throw[slack_error]`, classified auth vs api
    // (qualified constructor name — the boundary checks the tag against the schema const), so the
    // caller can catch it instead of the run panicking.
    katari.throw(new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }));
    // `katari.throw` never returns; the rethrow only satisfies the declared return type.
    throw error;
  }
});

katari.agent<{
  bot_token: string;
  app_token: string;
  channel: string;
  prompt: KatariText;
  controls: Array<KatariData<KatariRecord>>;
}>("slack_ask", async ({ bot_token, app_token, channel, prompt, controls }, context) => {
  const web = webClientFor(bot_token);
  const question = typeof prompt === "string" ? prompt : await prompt.text();
  const offered = await Promise.all(controls.map(readControl));
  // The answer arrives over the socket, so this call holds one for exactly as long as it waits — and lets
  // go in the `finally`, whichever way it ends. The question posts only once the connection is up: a
  // prompt whose answer has nowhere to arrive is worse than no prompt.
  const shared = acquireSocket(app_token);
  try {
    try {
      await shared.started;
    } catch (error) {
      // Opening the connection is now this call's failure rather than the provider's: classify and raise
      // it as the declared `slack_error` (a bad app-level token is `auth_error`) so the caller can catch
      // it instead of the run panicking. Nothing was posted.
      katari.throw(new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }));
    }
    let askTs: string;
    try {
      const posted = await web.chat.postMessage({
        channel,
        text: question,
        blocks: promptBlocks(question, offered),
      });
      if (posted.ts === undefined) {
        // A successful post always carries a ts; without it an answer cannot be correlated, so fail the
        // call rather than wait forever on an unidentifiable prompt.
        throw new Error("slack chat.postMessage returned no message ts");
      }
      askTs = posted.ts;
    } catch (error) {
      // Posting the prompt is the first Slack call that can fail; classify and raise it as the declared
      // `slack_error` exactly as slack_send does.
      katari.throw(new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }));
      // `katari.throw` never returns; the rethrow only satisfies definite assignment on `askTs`.
      throw error;
    }
    // The wait: the FIRST answer settles the ask. No time limit — the decision may land hours later; a
    // runtime restart interrupts the external call under the at-most-once rule. Every interaction envelope
    // is already acknowledged by the `slack_event` handler installed with the socket, so nothing is acked
    // here — this listener only reads the interaction and settles.
    let answered: Answered;
    try {
      answered = await awaitAnswer(shared.socket, web, offered, askTs, context.signal);
    } catch (error) {
      // A cancel is the runtime tearing this call down, not a Slack failure, so it is never reclassified as a
      // catchable `slack_error`. It still has to TIDY UP, though: an expired deadline is the ordinary way a
      // deadline-wrapped ask ends, and leaving its controls live would let a member press a prompt nobody is
      // waiting on any more. The edit is a plain Web API call, so it needs nothing this call is letting go of.
      if (error instanceof KatariCancelledError) {
        stripControls(web, channel, askTs, question, "(expired)");
        throw error;
      }
      // The platform broke the ask instead — a rejected `views.open`, a socket fault. The question is over
      // just as finally as an answered one, so its controls come off too; only the line left behind differs.
      stripControls(web, channel, askTs, question, "(failed)");
      katari.throw(new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }));
      // `katari.throw` never returns; the rethrow only satisfies definite assignment on `answered`.
      throw error;
    }
    stripControls(web, channel, askTs, question, answered.receipt);
    return answered.answer;
  } finally {
    releaseSocket(shared);
  }
});

katari.agent<{
  bot_token: string;
  app_token: string;
  channel: string;
  deliver_to: KatariAgent;
}>(
  "slack_watch",
  ({ bot_token, app_token, channel, deliver_to }, context) => {
    // Take the shared socket and attach the listener in the SAME synchronous turn, before the connection
    // is awaited: `start()` cannot deliver an event before this function returns, so a watch cannot miss a
    // message its own call was live for. The socket is let go of on every ending, so the last watch or ask
    // to finish closes it.
    const shared = acquireSocket(app_token);
    return new Promise<never>((_resolve, reject) => {
      const listener = (envelope: MessageEnvelope) => {
        const event = envelope.event;
        // Deliver only a user's own posts in the watched channel: a `bot_id` (this bot's replies
        // included, so delivering cannot loop) and every subtype except `file_share` (edits,
        // deletions, joins — different shapes, not new messages) are skipped. The remaining shapes
        // always carry a user; one that does not is not a user post, so it is skipped too.
        if (event.channel !== channel || event.user === undefined) return;
        if (event.bot_id !== undefined) return;
        if (event.subtype !== undefined && event.subtype !== "file_share") return;
        const author = event.user;
        const messageChannel = event.channel;
        // Deliver back into the runtime as an inner delegation; the callback's effects escalate
        // through this call to the app's handlers. Attachments download from Slack's file URL (the
        // bot token as a bearer header — Socket Mode has no public downloads) and lift into `file`
        // values first (one that fails to download is dropped rather than failing the whole
        // message). A delivery failure tears the watch down (the app's panic clause reports it).
        void (async () => {
          const files: KatariFile[] = [];
          for (const attachment of event.files ?? []) {
            const url = attachment.url_private_download ?? attachment.url_private;
            if (url === undefined) continue;
            const response = await fetch(url, {
              headers: { Authorization: `Bearer ${bot_token}` },
            });
            if (!response.ok) continue;
            files.push(
              await context.file(new Uint8Array(await response.arrayBuffer()), {
                ...(attachment.mimetype === undefined ? {} : { contentType: attachment.mimetype }),
              }),
            );
          }
          // One `message` data value, not a spread of positional fields: the callback's signature stays
          // the same as its Discord twin's when either platform grows a field.
          await deliver_to.call({
            value: new KatariData("slack.message", {
              channel: messageChannel,
              author,
              text: event.text ?? "",
              files,
              thread: event.thread_ts ?? null,
            }),
          });
        })().catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      };
      // Stop listening and let go of the socket, once: a start failure and a cancel can both arrive, and
      // a second release would take a holder off some other call's count.
      let listening = true;
      const stopListening = () => {
        if (!listening) return;
        listening = false;
        shared.socket.off("message", listener);
        releaseSocket(shared);
      };
      const fail = (error: Error) => {
        stopListening();
        reject(error);
      };
      shared.socket.on("message", listener);
      // The connect itself, which is THIS call's failure now that the provider connects nothing: a bad
      // app-level token or a network fault raises the declared `slack_error` rather than a panic.
      void shared.started.catch((error: unknown) => {
        fail(
          new KatariThrowError(
            new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }),
          ),
        );
      });
      // The runtime cancelled the call (a cancelled fiber, a re-forked watcher's predecessor, run
      // teardown): stop listening and settle as the port's expected cancellation, so the ordinary way a
      // watcher ends does not read as a fault in the diagnostics.
      context.signal.addEventListener("abort", () => fail(new KatariCancelledError()));
    });
  },
);
