// The sidecar half of `slack.ktr` — the Socket Mode WebSocket plus the Web API client. Handlers
// register under this file's module path (`slack.*`). Connections live in a module-level map for the
// sidecar process's lifetime (one process per snapshot), keyed by the opaque handle Katari carries
// around; the bot token rides in the entry because downloading a message's attachments needs it as a
// bearer header.
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

/** One live connection: the event socket, the Web API client, and the bot token the attachment
 *  downloads authenticate with. */
interface SlackConnection {
  socket: SocketModeClient;
  web: WebClient;
  botToken: string;
}

const clients = new Map<string, SlackConnection>();
let nextHandle = 1;

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

/** Replace the prompt's controls with a one-line record of how the ask ended — the SAME path for an answer
 *  and for a cancel, so a prompt whose deadline expired never keeps live controls a member can still press
 *  (pressing a dead control shows Slack's own interaction failure, which reads as a broken bot).
 *
 *  Best effort throughout: the answer is the valuable thing, and losing a human's decision to a failed
 *  cosmetic edit would be far worse than a prompt left looking live. The record is a fixed one-liner rather
 *  than an echo of what was submitted — a form's text is unbounded and would blow the block's own size cap,
 *  and what to post back is the program's decision, not this package's. */
async function stripControls(
  connection: SlackConnection,
  channel: string,
  askTs: string,
  question: string,
  receipt: string,
): Promise<void> {
  const outcome = `${question}\n→ ${receipt}`;
  const stripped: MessageBlock[] = [{ type: "section", text: { type: "mrkdwn", text: outcome } }];
  await connection.web.chat
    .update({ channel, ts: askTs, text: outcome, blocks: stripped })
    .catch(() => {});
}

/** The " (by <@U…>)" suffix on the channel's record, empty when Slack reported no user. */
function answeredBy(userId: string): string {
  return userId === "" ? "" : ` (by <@${userId}>)`;
}

/** Wait for the first answer to the prompt at `askTs`. Presses and choices answer directly; a form's
 *  press only opens its dialog, and the answer is the `view_submission` that follows. */
function awaitAnswer(
  connection: SlackConnection,
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
            void connection.web.views
              .open({ trigger_id: triggerId, view: modalView(control, askTs) })
              .catch(fail);
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
      connection.socket.off("interactive", listener);
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
    connection.socket.on("interactive", listener);
    signal.addEventListener("abort", abort);
  });
}

katari.agent<{ bot_token: string; app_token: string }>(
  "create_slack_client",
  async ({ bot_token, app_token }) => {
    const socket = new SocketModeClient({ appToken: app_token });
    // Acknowledge every envelope the moment it arrives, independently of any watcher: Slack re-sends
    // an event not acked within a few seconds, and a delivery into the runtime can take arbitrarily
    // long, so acking from the delivery path would turn every slow handler into duplicates. A failed
    // ack (the socket dropped mid-reply) is deliberately ignored — Slack just re-sends the envelope,
    // which is the at-least-once contract the watch documents.
    //
    // The empty ack is also what an interaction needs: a `block_actions` wants nothing back, and an
    // empty ack of a `view_submission` is exactly what CLOSES the submitted dialog. It is the reason a
    // form's inputs cannot be rejected with per-field errors — the envelope is already answered by the
    // time this package sees it, which `ask` documents as the contract.
    socket.on("slack_event", ({ ack }: { ack: () => Promise<void> }) => {
      void ack().catch(() => {});
    });
    try {
      // Opening the Socket Mode WebSocket is the connect: a bad app-level token or a transient network
      // fault fails here. Raise it as the declared `prelude.throw[slack_error]`, classified auth vs api
      // (the credential is fixed at start, so a bad token cannot recover), so the provider's caller can
      // catch it instead of the run panicking. Nothing to close — the socket never came up.
      await socket.start();
    } catch (error) {
      katari.throw(new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }));
    }
    const handle = `slack-${nextHandle}`;
    nextHandle += 1;
    clients.set(handle, { socket, web: new WebClient(bot_token), botToken: bot_token });
    return handle;
  },
);

katari.agent<{ client: string }>("slack_close", async ({ client }) => {
  // The provider arms this as a `finally`, so a run that ends (completes, is cancelled, or unwinds)
  // tears its Socket Mode connection down: a socket left open keeps receiving events, and Slack
  // round-robins each event across every socket open on the app token, so a dead run's zombie socket
  // would swallow messages (acking them) that a live bot then never sees.
  const connection = clients.get(client);
  // Idempotent: an unknown or already-closed handle is a no-op — a finalizer may run more than once,
  // and a sidecar restart drops the map entirely.
  if (connection === undefined) return null;
  // Drop the entry before disconnecting so a re-run (or a concurrent lookup) cannot see it half-closed.
  clients.delete(client);
  // `disconnect` ends the Socket Mode session — the SDK's documented shutdown: it stops reconnecting
  // and closes the WebSocket. The Web API client holds no persistent connection, so nothing to close.
  await connection.socket.disconnect();
  return null;
});

katari.agent<{
  client: string;
  channel: string;
  text: string;
  thread_ts: string | null;
  files: KatariFile[];
}>("slack_send", async ({ client, channel, text, thread_ts, files }) => {
  // An unknown handle is a program defect (a `client` value the runtime never minted), so it stays a
  // bare throw = panic; only the Slack API calls below fail at execution and become a catchable
  // `slack_error`.
  const connection = connectionOf(client);
  try {
    if (files.length === 0) {
      const response = await connection.web.chat.postMessage({
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
      const response = await connection.web.files.uploadV2({
        channel_id: channel,
        ...(text === "" ? {} : { initial_comment: text }),
        file_uploads: uploads,
      });
      return firstShareTs(response) ?? "";
    }
    const response = await connection.web.files.uploadV2({
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
  client: string;
  channel: string;
  prompt: KatariText;
  controls: Array<KatariData<KatariRecord>>;
}>("slack_ask", async ({ client, channel, prompt, controls }, context) => {
  const connection = connectionOf(client);
  const question = typeof prompt === "string" ? prompt : await prompt.text();
  const offered = await Promise.all(controls.map(readControl));
  let askTs: string;
  try {
    const posted = await connection.web.chat.postMessage({
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
  // is already acknowledged by the global `slack_event` handler installed at connect, so nothing is
  // acked here — this listener only reads the interaction and settles.
  let answered: Answered;
  try {
    answered = await awaitAnswer(connection, offered, askTs, context.signal);
  } catch (error) {
    // A cancel is the runtime tearing this call down, not a Slack failure, so it is never reclassified as a
    // catchable `slack_error`. It still has to TIDY UP, though: an expired deadline is the ordinary way a
    // deadline-wrapped ask ends, and leaving its controls live would let a member press a prompt nobody is
    // waiting on any more. The same strip an answer takes, one line different.
    if (error instanceof KatariCancelledError) {
      await stripControls(connection, channel, askTs, question, "(expired)");
      throw error;
    }
    katari.throw(new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }));
    // `katari.throw` never returns; the rethrow only satisfies definite assignment on `answered`.
    throw error;
  }
  await stripControls(connection, channel, askTs, question, answered.receipt);
  return answered.answer;
});

katari.agent<{ client: string; channel: string; deliver_to: KatariAgent }>(
  "slack_watch",
  ({ client, channel, deliver_to }, context) => {
    const connection = connectionOf(client);
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
              headers: { Authorization: `Bearer ${connection.botToken}` },
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
            message: new KatariData("slack.message", {
              channel: messageChannel,
              author,
              text: event.text ?? "",
              files,
              thread: event.thread_ts ?? null,
            }),
          });
        })().catch((error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };
      const cleanup = () => connection.socket.off("message", listener);
      connection.socket.on("message", listener);
      // The runtime cancelled the call (run cancel / teardown): stop listening and settle.
      context.signal.addEventListener("abort", () => {
        cleanup();
        reject(new Error("slack watch cancelled"));
      });
    });
  },
);

function connectionOf(handle: string): SlackConnection {
  const connection = clients.get(handle);
  if (connection === undefined) {
    throw new Error(`unknown slack client handle: ${handle}`);
  }
  return connection;
}
