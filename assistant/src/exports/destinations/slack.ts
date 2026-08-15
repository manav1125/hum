/**
 * Slack destination.
 *
 * Slack is the only destination that does not go through Composio: it is a
 * thin adapter over `uploadFileToSlack`, the v2 external-upload flow Cue
 * already implements for channel egress, rather than a second implementation
 * of the same three-step dance.
 *
 * The consequence is worth stating plainly, because it is not what the
 * Connectors page implies. This route authenticates with the **Slack channel
 * bot token** (`credential/slack_channel/bot_token`) — the token from the
 * Slack app that lets Cue talk in Slack. It does NOT use the Composio Slack
 * connector, so a Composio Slack connection showing "connected" on the
 * Connectors page does nothing for this path, and an install that has only
 * the Composio connection cannot send a file here at all. `notConnected`
 * below therefore has to name the right credential; sending the user to
 * Connectors, where Slack already reads as connected, is a dead end.
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
          ? "Sending a file to Slack needs Cue's Slack channel bot token, which is not set on this install. That is a different credential from the Slack connector on the Connectors page — a Slack connector shown there as connected will not do it. Add the Slack bot and app tokens on the assistant's Channels surface, then try again."
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
