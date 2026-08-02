/**
 * Presentation-layer cleanup for contact lists (the Memory "People" rail,
 * the People page, and any other client of `GET /contacts`).
 *
 * Pure functions over already-loaded contacts — this module never reads or
 * writes the database. Stored contact rows are left untouched; duplicates
 * and degenerate note bodies are cleaned up at read time only.
 *
 * Why: contact ingress paths (channel binding, extraction) can create a
 * second contact row for a person who already exists (e.g. a "Manav" guardian
 * row plus a bare "Manav" contact row created during Slack ingress), and some
 * rows carry degenerate notes (the literal word "guardian" — body === role).
 * The rail would then show two near-empty cards for the same person.
 */

import {
  type ContactWithChannels,
  CORRESPONDENCE_RETIRED_REASON_PREFIX,
} from "./types.js";

/**
 * True when every channel this contact has was revoked by the correspondence
 * cleanup — i.e. Cue provisioned them from mail the arrival gate never once
 * surfaced, and the owner never touched the row.
 *
 * Hidden at READ time, exactly like the duplicate collapse above: the row and
 * its history stay on disk untouched, so the undo run is a database write
 * rather than a resurrection. The marker is required, so a channel the owner
 * revoked by hand still renders — a person you blocked is still a person you
 * know, and making them vanish would be a different product decision than the
 * one this module is allowed to make.
 */
export function isRetiredCorrespondent(
  contact: Pick<ContactWithChannels, "channels">,
): boolean {
  if (contact.channels.length === 0) return false;
  return contact.channels.every(
    (ch) =>
      ch.status === "revoked" &&
      (ch.revokedReason ?? "").startsWith(CORRESPONDENCE_RETIRED_REASON_PREFIX),
  );
}

/**
 * Canonical form of a display name for duplicate detection:
 * case-insensitive, whitespace-insensitive (collapsed + trimmed).
 */
export function normalizeDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when a notes body is trivially degenerate and should not be rendered
 * as a person-card body:
 *   - empty / whitespace-only,
 *   - literally the contact's role or contactType (e.g. "guardian"),
 *   - a single word (no meaningful sentence content, e.g. "guardian").
 */
export function isDegenerateNotes(
  notes: string | null | undefined,
  contact: Pick<ContactWithChannels, "role" | "contactType">,
): boolean {
  if (notes == null) return true;
  const trimmed = notes.trim();
  if (trimmed === "") return true;
  const lowered = trimmed.toLowerCase();
  if (lowered === contact.role.toLowerCase()) return true;
  if (lowered === contact.contactType.toLowerCase()) return true;
  // Single token with no internal whitespace ("guardian", "ceo", …) carries
  // no dossier content worth a card body.
  if (!/\s/.test(trimmed)) return true;
  return false;
}

/** Notes with degenerate bodies stripped to null (presentation only). */
function cleanNotes(contact: ContactWithChannels): string | null {
  return isDegenerateNotes(contact.notes, contact) ? null : contact.notes;
}

/**
 * Pick the canonical row of a duplicate group: prefer the guardian row, then
 * the row with the most channels (richest identity), then the oldest row.
 */
function pickCanonical(group: ContactWithChannels[]): ContactWithChannels {
  return group.reduce((best, next) => {
    if ((next.role === "guardian") !== (best.role === "guardian")) {
      return next.role === "guardian" ? next : best;
    }
    if (next.channels.length !== best.channels.length) {
      return next.channels.length > best.channels.length ? next : best;
    }
    return next.createdAt < best.createdAt ? next : best;
  });
}

function mergeGroup(group: ContactWithChannels[]): ContactWithChannels {
  const canonical = pickCanonical(group);
  if (group.length === 1) {
    return { ...canonical, notes: cleanNotes(canonical) };
  }

  // Channels: canonical's first, then the rest, unique by channel id.
  const seenChannelIds = new Set<string>();
  const channels = [
    ...canonical.channels,
    ...group.filter((c) => c !== canonical).flatMap((c) => c.channels),
  ].filter((ch) => {
    if (seenChannelIds.has(ch.id)) return false;
    seenChannelIds.add(ch.id);
    return true;
  });

  // Notes: merge every non-degenerate body, deduped, newline-joined.
  const seenNotes = new Set<string>();
  const notes = group
    .map((c) => cleanNotes(c))
    .filter((n): n is string => n !== null)
    .filter((n) => {
      const key = n.trim();
      if (seenNotes.has(key)) return false;
      seenNotes.add(key);
      return true;
    });

  const interactionCount = channels.reduce(
    (sum, ch) => sum + ch.interactionCount,
    0,
  );
  const lastInteraction =
    channels.reduce((max, ch) => Math.max(max, ch.lastInteraction ?? 0), 0) ||
    null;

  return {
    ...canonical,
    role: group.some((c) => c.role === "guardian")
      ? "guardian"
      : canonical.role,
    notes: notes.length > 0 ? notes.join("\n") : null,
    channels,
    interactionCount,
    lastInteraction,
    createdAt: Math.min(...group.map((c) => c.createdAt)),
    updatedAt: Math.max(...group.map((c) => c.updatedAt)),
  };
}

/**
 * Collapse duplicate person rows (same normalized display name) into one
 * card each, merging channels/notes/interaction stats from the duplicates,
 * strip degenerate note bodies everywhere, and drop retired correspondents.
 *
 * Order-preserving: each merged card sits where the group's first row
 * appeared in the input. Nameless rows are passed through unmerged (an empty
 * name is not evidence of identity).
 */
export function dedupeContactsForDisplay(
  input: ContactWithChannels[],
): ContactWithChannels[] {
  // Before grouping: a retired robot must not pull a real person into its
  // group and hand them a revoked channel.
  const contacts = input.filter((c) => !isRetiredCorrespondent(c));
  const groups = new Map<string, ContactWithChannels[]>();
  // Position (in the output) of each group / passthrough row, in input order.
  const ordered: Array<
    | { kind: "group"; key: string }
    | { kind: "single"; contact: ContactWithChannels }
  > = [];

  for (const contact of contacts) {
    const key = normalizeDisplayName(contact.displayName);
    if (key === "") {
      ordered.push({ kind: "single", contact });
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.push(contact);
    } else {
      groups.set(key, [contact]);
      ordered.push({ kind: "group", key });
    }
  }

  return ordered.map((entry) =>
    entry.kind === "single"
      ? { ...entry.contact, notes: cleanNotes(entry.contact) }
      : mergeGroup(groups.get(entry.key)!),
  );
}
