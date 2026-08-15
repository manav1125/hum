/**
 * The vocabulary every export destination shares.
 *
 * A destination is deliberately small: it receives an already-rendered export
 * and a target, and it answers whether the destination *confirmed* the write.
 * Everything a destination might otherwise want to do for itself — resolving
 * the bytes, checking the size cap, deciding whether the payload shape is even
 * sendable — is lifted into the primitive (`send-export.ts`), so that adding a
 * destination is a registry entry rather than a project.
 */

/** The bytes of one export, plus what they are. */
export interface ExportPayload {
  bytes: Buffer;
  /** Filename as it should appear at the destination, with extension. */
  filename: string;
  mimeType: string;
  /**
   * A human title for the thing being sent (the document's title, not the
   * filename). Destinations that create a *named object* rather than a file —
   * a Google Doc, a Notion page — use this.
   */
  title?: string;
}

/**
 * Whether a payload can be handed to a destination that only speaks text.
 *
 * Text-shaped exports (markdown, html, plain) can become a Google Doc, a
 * Notion page body, or a HubSpot note. Binary ones (pdf, png, docx, xlsx)
 * cannot — they can only be uploaded as files.
 */
export function isTextPayload(payload: ExportPayload): boolean {
  const mime = payload.mimeType.toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xhtml+xml"
  );
}

/** The payload's text, or null when it is binary. */
export function payloadText(payload: ExportPayload): string | null {
  return isTextPayload(payload) ? payload.bytes.toString("utf8") : null;
}

/**
 * Where inside the destination the export should land.
 *
 * Deliberately loose: a Slack channel id, a Drive folder id, a Notion page id
 * and a HubSpot record id are all "the place", and forcing them into one named
 * field keeps the tool schema (and the model's job) simple.
 */
export interface DestinationTarget {
  /** The destination-specific id: channel, folder, page, or record. */
  id?: string;
  /** Optional note posted alongside the file, where the destination has one. */
  message?: string;
  /** Slack only: reply into an existing thread. */
  threadTs?: string;
  /** HubSpot only: which object type `id` refers to. */
  objectType?: string;
}

/**
 * Why a send did not happen. Kept as a closed set so callers (and the model)
 * get a consistent, actionable reason rather than free-form prose.
 */
export type DestinationFailureReason =
  /** The connector is not connected, or its connection has gone stale. */
  | "not_connected"
  /** The destination cannot accept this kind of file at all. */
  | "unsupported_payload"
  /** The caller did not name a place to put it, or named an invalid one. */
  | "bad_target"
  /** Bigger than what the destination (or the transport) will take. */
  | "too_large"
  /** The destination was reached and refused, or the transport failed. */
  | "destination_error"
  /** No such destination id. */
  | "unknown_destination";

export type DestinationOutcome =
  | {
      ok: true;
      /** One line for the model to relay to the user. */
      summary: string;
      /**
       * What the destination itself returned — a file id, a document id, a
       * URL. Non-empty on success by construction: a destination that cannot
       * produce any evidence of the write must not report `ok`.
       */
      confirmation: Record<string, unknown>;
    }
  | {
      ok: false;
      summary: string;
      reason: DestinationFailureReason;
    };

/** Convenience constructors, so destinations read as a list of verdicts. */
export function sent(
  summary: string,
  confirmation: Record<string, unknown>,
): DestinationOutcome {
  return { ok: true, summary, confirmation };
}

export function notSent(
  reason: DestinationFailureReason,
  summary: string,
): DestinationOutcome {
  return { ok: false, summary, reason };
}

export interface DestinationSendContext {
  signal?: AbortSignal;
}

export interface Destination {
  /** Stable id used in the tool schema. */
  id: string;
  /** Human name, used in messages. */
  label: string;
  /**
   * The Composio toolkit this destination rides on, or null when it does not
   * go through Composio (Slack uses Cue's own bot token).
   */
  toolkit: string | null;
  /** What payload shapes this destination can take. */
  accepts: { binary: boolean; text: boolean };
  /**
   * Hard size ceiling for this destination, in bytes. The primitive enforces
   * it before any network call so an oversized send fails fast and locally.
   */
  maxBytes: number;
  /** What `target.id` means here — surfaced in the tool description. */
  targetHelp: string;
  send(
    payload: ExportPayload,
    target: DestinationTarget,
    context: DestinationSendContext,
  ): Promise<DestinationOutcome>;
}
