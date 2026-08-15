/**
 * The destination registry.
 *
 * Adding a place a document can be sent is an entry in this map — not a new
 * tool, not a new approval path, not a new transport. Everything a destination
 * shares with the others (byte resolution, size caps, payload-shape checks,
 * failure normalisation, the send-class approval gate) lives one level up in
 * `send-export.ts`.
 */

import { googleDocsDestination } from "./google-docs.js";
import { googleDriveDestination } from "./google-drive.js";
import { hubspotDestination } from "./hubspot.js";
import { notionDestination } from "./notion.js";
import { slackDestination } from "./slack.js";
import type { Destination } from "./types.js";

const ALL: readonly Destination[] = [
  slackDestination,
  googleDriveDestination,
  googleDocsDestination,
  hubspotDestination,
  notionDestination,
];

const BY_ID = new Map<string, Destination>(ALL.map((d) => [d.id, d]));

export function getDestination(id: string): Destination | undefined {
  return BY_ID.get(id.trim().toLowerCase());
}

export function listDestinations(): readonly Destination[] {
  return ALL;
}

export function destinationIds(): string[] {
  return ALL.map((d) => d.id);
}

/**
 * One line per destination for the tool description, so the model learns what
 * each `target` means and which formats each one can actually take from the
 * schema rather than by trial and error.
 */
export function describeDestinations(): string {
  return ALL.map((d) => {
    const shapes = [
      d.accepts.text ? "text formats (markdown, html)" : null,
      d.accepts.binary ? "binary formats (pdf, png, docx, xlsx)" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return `- ${d.id} (${d.label}): accepts ${shapes}. Target: ${d.targetHelp}`;
  }).join("\n");
}
