/**
 * Slack destination — the one that proves the primitive.
 *
 * Slack is the only destination that does not go through Composio: Cue already
 * holds a Slack bot token and already implements the v2 external-upload flow
 * for channel egress, so this is a thin adapter over `uploadFileToSlack`
 * rather than a second implementation. (The Composio Slack toolkit is
 * JSON-only and structurally cannot do a multipart file upload, so routing
 * through it would be a downgrade.)
 */

import { uploadFileToSlack } from "../../messaging/providers/slack/send.js";
import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import { getLogger } from "../../util/logger.js";
import type {
  Destination,
  DestinationOutcome,
  DestinationSendContext,
  DestinationTarget,
  ExportPayload,
} from "./types.js";
import { notSent, sent } from "./types.js";

const log = getLogger("export-destination-slack");

/** Slack accepts far more, but this matches the outbound-attachment ceiling. */
const SLACK_MAX_BYTES = 100 * 1024 * 1024;

export const slackDestination: Destination = {
  id: "slack",
  label: "Slack",
  toolkit: null,
  accepts: { binary: true, text: true },
  maxBytes: SLACK_MAX_BYTES,
  targetHelp:
    "Slack channel ID (e.g. C0123456789). Optionally `thread_ts` to reply in a thread.",

  async send(
    payload: ExportPayload,
    target: DestinationTarget,
    _context: DestinationSendContext,
  ): Promise<DestinationOutcome> {
    const channelId = target.id?.trim();
    if (!channelId) {
      return notSent(
        "bad_target",
        "Name the Slack channel ID to send the file to.",
      );
    }

    let fileId: string;
    try {
      const result = await uploadFileToSlack(
        channelId,
        payload.bytes,
        payload.filename,
        target.threadTs,
      );
      fileId = result.fileId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, channelId }, "Slack export upload failed");
      const notConnected =
        message.includes("bot token not configured") ||
        message.includes("not_authed") ||
        message.includes("invalid_auth");
      return notSent(
        notConnected ? "not_connected" : "destination_error",
        notConnected
          ? "Slack is not connected — connect it in Connectors, then try again."
          : `Slack refused the upload: ${message}`,
      );
    }

    // The note is a courtesy, not the delivery: the file is already in the
    // channel by this point, so a failed note must not turn a real success
    // into a reported failure.
    if (target.message) {
      try {
        await sendSlackReply(
          channelId,
          target.message,
          target.threadTs ? { threadTs: target.threadTs } : undefined,
        );
      } catch (err) {
        log.warn({ err, channelId }, "Slack export note failed after upload");
      }
    }

    return sent(`Uploaded ${payload.filename} to Slack channel ${channelId}.`, {
      fileId,
      channelId,
      ...(target.threadTs ? { threadTs: target.threadTs } : {}),
    });
  },
};
