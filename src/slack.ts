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
import { katari, type KatariAgent, type KatariFile } from "@katari-lang/port";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

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

katari.agent<{
  client: string;
  channel: string;
  text: string;
  thread_ts: string | null;
  files: KatariFile[];
}>("slack_send", async ({ client, channel, text, thread_ts, files }) => {
  const connection = connectionOf(client);
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
