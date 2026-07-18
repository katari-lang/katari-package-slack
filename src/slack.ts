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

import { Buffer } from "node:buffer";
import { katari, KatariData, type KatariAgent, type KatariFile } from "@katari-lang/port";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

/** Read a property off an unknown value without asserting its shape. */
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
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

/** The Slack platform error code out of a failed Web API call (`chat.postMessage` / `files.uploadV2`
 *  reject with a `WebAPICallError` whose `data.error` is the code, e.g. "invalid_auth"), or undefined
 *  when the failure carries none (a transport fault). */
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
 *  everything else (rate limit, transport, a per-channel refusal) is `api_error`. */
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

katari.agent<{ bot_token: string; app_token: string }>(
  "create_slack_client",
  async ({ bot_token, app_token }) => {
    const socket = new SocketModeClient({ appToken: app_token });
    // Acknowledge every envelope the moment it arrives, independently of any watcher: Slack re-sends
    // an event not acked within a few seconds, and a delivery into the runtime can take arbitrarily
    // long, so acking from the delivery path would turn every slow handler into duplicates. A failed
    // ack (the socket dropped mid-reply) is deliberately ignored — Slack just re-sends the envelope,
    // which is the at-least-once contract the watch documents.
    socket.on("slack_event", ({ ack }: { ack: () => Promise<void> }) => {
      void ack().catch(() => {});
    });
    await socket.start();
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
      await connection.web.chat.postMessage({
        channel,
        text,
        ...(thread_ts === null ? {} : { thread_ts }),
      });
      return null;
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
    if (thread_ts === null) {
      await connection.web.files.uploadV2({
        channel_id: channel,
        ...(text === "" ? {} : { initial_comment: text }),
        file_uploads: uploads,
      });
    } else {
      await connection.web.files.uploadV2({
        channel_id: channel,
        thread_ts,
        ...(text === "" ? {} : { initial_comment: text }),
        file_uploads: uploads,
      });
    }
    return null;
  } catch (error) {
    // Raise the execution failure as the declared `prelude.throw[slack_error]`, classified auth vs api
    // (qualified constructor name — the boundary checks the tag against the schema const), so the
    // caller can catch it instead of the run panicking.
    katari.throw(new KatariData(slackErrorConstructor(error), { message: slackErrorMessage(error) }));
  }
});

katari.agent<{ client: string; channel: string; deliver_to: KatariAgent }>(
  "slack_watch",
  ({ client, channel, deliver_to }, context) => {
    const connection = connectionOf(client);
    return new Promise<never>((_resolve, reject) => {
      const listener = (envelope: MessageEnvelope) => {
        const message = envelope.event;
        // Deliver only a user's own posts in the watched channel: a `bot_id` (this bot's replies
        // included, so delivering cannot loop) and every subtype except `file_share` (edits,
        // deletions, joins — different shapes, not new messages) are skipped. The remaining shapes
        // always carry a user; one that does not is not a user post, so it is skipped too.
        if (message.channel !== channel || message.user === undefined) return;
        if (message.bot_id !== undefined) return;
        if (message.subtype !== undefined && message.subtype !== "file_share") return;
        const user = message.user;
        const messageChannel = message.channel;
        // Deliver back into the runtime as an inner delegation; the callback's effects escalate
        // through this call to the app's handlers. Attachments download from Slack's file URL (the
        // bot token as a bearer header — Socket Mode has no public downloads) and lift into `file`
        // values first (one that fails to download is dropped rather than failing the whole
        // message). A delivery failure tears the watch down (the app's panic clause reports it).
        void (async () => {
          const files: KatariFile[] = [];
          for (const attachment of message.files ?? []) {
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
          await deliver_to.call({
            channel: messageChannel,
            user,
            text: message.text ?? "",
            thread_ts: message.thread_ts ?? null,
            files,
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
