/**
 * Notes that arrive on their own — Halo, forwarded mail, meeting capture.
 *
 * ## The restraint that makes this safe
 *
 * **An arrival becomes a NOTE, never a task.** That single rule is what stops
 * inbound capture from becoming the silent-write problem at volume: a
 * wearable that hears six hours of your day, turned straight into work items,
 * is an assistant filling your HQ with things you never agreed to. As a note
 * it obeys acceptance exactly like something you typed yourself — Cue can
 * propose, and you decide.
 *
 * ## Why this gives Halo a destination
 *
 * A wearable that captures your day needs somewhere for the day to *land*,
 * and a note is the right shape: unstructured, reviewable, and already wired
 * to become work. "Halo captures your day, Cue turns it into work" is only
 * true because of this file — which is also why it is load-bearing rather
 * than a nice-to-have.
 *
 * ## Provenance is stated, never inferred
 *
 * Every arrival-note says where it came from and, for audio, that the
 * recording stayed on the device. A note whose origin is invisible is one the
 * owner has to take on trust, and the whole point of routing arrivals through
 * Notes rather than into HQ is that they are inspectable first.
 */

import { getLogger } from "../util/logger.js";
import { createNote, type Note } from "./note-store.js";

const log = getLogger("note-arrivals");

/**
 * Where an inbound note came from.
 *
 *  · `halo`    — the wearable. Audio stays on the device; only the transcript
 *                and its summary travel.
 *  · `email`   — forwarded to the notes address.
 *  · `meeting` — a meeting capture with its recap.
 */
export type ArrivalNoteChannel = "halo" | "email" | "meeting";

export interface ArrivalNoteInput {
  channel: ArrivalNoteChannel;
  title: string;
  body: string;
  /** When it HAPPENED — the conversation, the mail, the meeting. */
  occurredAt?: number;
  /** Local path for a recording. Never uploaded; may be deleted separately. */
  audioPath?: string | null;
  audioDurationMs?: number | null;
  /** The words that were actually said, kept apart from any summary. */
  transcript?: string | null;
  /**
   * True when `body` is Cue's summary rather than a verbatim record — which
   * is the normal case for Halo and meetings, and must be labelled as such
   * wherever it renders.
   */
  bodyIsSummary?: boolean;
  /** A project guess. Nullable, and staying null is fine forever. */
  projectId?: string | null;
}

/** How each channel introduces itself on the card. */
const PROVENANCE: Record<ArrivalNoteChannel, string> = {
  halo: "from Halo",
  email: "you forwarded this to notes@",
  meeting: "meeting capture",
};

export function arrivalProvenance(
  channel: ArrivalNoteChannel,
  hasLocalAudio: boolean,
): string {
  const base = PROVENANCE[channel];
  return hasLocalAudio ? `${base} · audio on device` : base;
}

/**
 * Land an arrival as a note.
 *
 * Creates a note and nothing else. This module deliberately holds no
 * work-item writer and no extractor: reading it for things to do happens
 * later, on the same on-close-or-on-demand path as anything typed, and
 * filing happens only when the owner accepts. The guard test over the
 * acceptance boundary covers this file for exactly that reason.
 *
 * Never throws — an inbound capture that fails must not take down the
 * watcher, the wearable sync or the meeting recap that called it.
 */
export function landArrivalAsNote(input: ArrivalNoteInput): Note | null {
  const body = input.body?.trim();
  if (!body) return null;

  try {
    return createNote({
      title: input.title.trim() || "Untitled note",
      body,
      source: "arrival",
      sourceDetail: input.channel,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.audioPath !== undefined ? { audioPath: input.audioPath } : {}),
      ...(input.audioDurationMs !== undefined
        ? { audioDurationMs: input.audioDurationMs }
        : {}),
      ...(input.transcript !== undefined
        ? { transcript: input.transcript }
        : {}),
      // Defaults true for Halo and meetings: both arrive as Cue's prose over
      // someone's speech, and prose that is not labelled a summary reads as a
      // quote. Being wrong in that direction puts words in people's mouths.
      bodyIsSummary: input.bodyIsSummary ?? input.channel !== "email",
      // When it HAPPENED. A kitchen conversation at 09:14 that syncs at 18:00
      // belongs at 09:14 in the list, or the day reads out of order.
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  } catch (err) {
    log.warn(
      { err: String(err), channel: input.channel },
      "could not land an arrival as a note",
    );
    return null;
  }
}
