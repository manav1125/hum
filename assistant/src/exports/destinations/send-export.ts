/**
 * The primitive: take an export's bytes, hand them to a destination.
 *
 * This is the single place where "send a file somewhere" is implemented. A
 * destination only has to know how to talk to its own API; everything that is
 * true of *every* send is enforced here, once:
 *
 *  - the destination exists,
 *  - the payload shape is one the destination can actually take,
 *  - the payload is inside the destination's size ceiling,
 *  - a destination that throws is a failure, not a success,
 *  - a success is only a success if the destination confirmed it.
 *
 * That last pair is the point. The worst outcome for an egress feature is
 * telling the user their document arrived somewhere it did not, so there is
 * deliberately no code path here that reports `ok` without a confirmation
 * payload from the far side.
 */

import { getLogger } from "../../util/logger.js";
import { getDestination } from "./registry.js";
import type {
  DestinationOutcome,
  DestinationTarget,
  ExportPayload,
} from "./types.js";
import { isTextPayload, notSent } from "./types.js";

const log = getLogger("send-export");

export interface SendExportRequest {
  payload: ExportPayload;
  destinationId: string;
  target?: DestinationTarget;
  signal?: AbortSignal;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Send one rendered export to one destination.
 *
 * Never throws: every failure — unknown destination, wrong shape, oversized,
 * network, or a destination that threw — comes back as a structured
 * `{ ok: false }` outcome so the caller has one thing to report and the model
 * cannot mistake an exception for a delivery.
 */
export async function sendExportToDestination(
  request: SendExportRequest,
): Promise<DestinationOutcome> {
  const { payload, destinationId } = request;
  const target = request.target ?? {};

  const destination = getDestination(destinationId);
  if (!destination) {
    return notSent(
      "unknown_destination",
      `"${destinationId}" is not a destination Cue can send to.`,
    );
  }

  const isText = isTextPayload(payload);
  if (isText && !destination.accepts.text) {
    return notSent(
      "unsupported_payload",
      `${destination.label} cannot take ${payload.filename} — it needs a binary format (pdf, png, docx or xlsx).`,
    );
  }
  if (!isText && !destination.accepts.binary) {
    return notSent(
      "unsupported_payload",
      `${destination.label} cannot take ${payload.filename} — export the document as markdown instead.`,
    );
  }

  if (payload.bytes.length === 0) {
    return notSent(
      "unsupported_payload",
      `${payload.filename} is empty, so there is nothing to send.`,
    );
  }

  if (payload.bytes.length > destination.maxBytes) {
    return notSent(
      "too_large",
      `${payload.filename} is ${formatBytes(payload.bytes.length)}; ${destination.label} accepts at most ${formatBytes(destination.maxBytes)}.`,
    );
  }

  let outcome: DestinationOutcome;
  try {
    outcome = await destination.send(payload, target, {
      signal: request.signal,
    });
  } catch (err) {
    // A destination that throws has told us nothing about whether the write
    // happened, so the only honest verdict is failure.
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, destination: destination.id },
      "Destination threw during send",
    );
    return notSent(
      "destination_error",
      `${destination.label} could not be reached: ${message}`,
    );
  }

  // Belt for the destinations' braces: an `ok` with nothing to point at is not
  // a confirmed delivery, whatever the destination believes.
  if (outcome.ok && Object.keys(outcome.confirmation).length === 0) {
    log.error(
      { destination: destination.id },
      "Destination reported success with no confirmation",
    );
    return notSent(
      "destination_error",
      `${destination.label} reported success but returned nothing to confirm the file arrived.`,
    );
  }

  return outcome;
}
