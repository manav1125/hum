/**
 * People — the honest data layer behind the phone's M3 (People) and F4 (a
 * person) screens.
 *
 * ## Why this file exists at all
 *
 * Design's M3/F4 frames render three relationship states as first-class
 * furniture: *you owe a reply* · *waiting on her* · *going quiet*. Exactly one
 * of those three is computable from what the daemon returns today, and the
 * difference matters more than the frame does.
 *
 * `GET /v1/assistants/{id}/contacts` returns `lastInteraction` and
 * `interactionCount` per contact — an elapsed-time fact and a volume fact.
 * There is no direction on an interaction anywhere in the API (the dossier's
 * `interactions[]` carries `kind` / `conversationId` / `channel` / `title` /
 * `at`, and nothing that says who spoke last), so:
 *
 *  · **going quiet** — derivable. A real prior relationship plus a long gap.
 *    The card always shows the gap in days, so the claim is checkable against
 *    the same number the reader can see.
 *  · **you owe a reply** — NOT derivable. Needs the direction of the last
 *    message. `relationshipState()` never returns it, and the People screens
 *    render no chip for it. When the daemon grows a direction field, add the
 *    branch here and both screens pick it up.
 *  · **waiting on her** — NOT derivable, same reason.
 *
 * A People surface that guessed "you owe a reply" from a timestamp would be
 * the exact failure this codebase has shipped before: a plausible-looking
 * claim assembled from defaults. Absent beats invented.
 *
 * ## What Cue has learned
 *
 * Real, and sparse. `contact_memory` rows are written by the extraction job
 * that reported success 697 times while writing nothing; the budget fix landed
 * 2026-08-02 and it now writes. On the owner's production instance that means
 * a handful of contacts have learnings and most have none — so
 * {@link learnedSummary} distinguishes four outcomes that are NOT the same
 * sentence, and the screens must render them differently:
 *
 *   `error`     the fetch failed — say so, offer a retry, never show "nothing".
 *   `degraded`  extraction runs and learns nothing — the daemon's own reason.
 *   `empty`     the pipeline is fine and there is genuinely nothing yet.
 *   `learned`   real statements, with real provenance.
 *
 * The list reads memory in bulk (`POST people/memory/bulk`, one call per
 * page), and that response carries a per-contact `status` for the same reason:
 * `empty` and `unavailable` are both zero rows on the wire, and only the
 * status separates "we looked, there is nothing" from "we could not look".
 * {@link learnedSummaryFromBulk} maps one slot of that response onto the four
 * outcomes above.
 */

import type { ContactPayload } from "@/domains/contacts/types";
import type {
  ContactsByIdMemoryGetResponse,
  PeopleMemoryBulkPostResponse,
} from "@/generated/daemon/types.gen";

export type ContactMemoryRow = ContactsByIdMemoryGetResponse["memory"][number];

/**
 * One contact's slot in a bulk read. `status` is the daemon's own verdict:
 * `learned` / `empty` / `unavailable`, where the last means *we could not
 * look* — a failed read or an id the contact store doesn't have.
 */
export type ContactMemoryReadEntry =
  PeopleMemoryBulkPostResponse["contacts"][number];

const DAY_MS = 86_400_000;

/**
 * A contact is "going quiet" only when there is a relationship to go quiet
 * *from*. One exchange three weeks ago is a one-off, not a fading thread.
 */
export const QUIET_AFTER_DAYS = 10;
export const QUIET_MIN_EXCHANGES = 3;

/** Recent enough that "quiet" would be wrong. */
export const ACTIVE_WITHIN_DAYS = 3;

export type RelationshipStateId = "quiet" | "active" | "known" | "new";

export interface RelationshipState {
  id: RelationshipStateId;
  /** The chip text. Carries the state on its own — never colour alone. */
  label: string;
  /** Border/label tone. `warn` tints the card; the label still says it. */
  tone: "warn" | "neutral";
  /** Real elapsed days since the last exchange, when there was one. */
  days: number | null;
}

/** Epoch in seconds or ms → ms. The daemon has shipped both. */
export function toMs(value: number | null | undefined): number | null {
  if (!value) return null;
  return value > 1e12 ? value : value * 1000;
}

/** Whole days between `then` and `now`, floor. Negative clocks read as 0. */
export function daysSince(
  epoch: number | null | undefined,
  now: number,
): number | null {
  const ms = toMs(epoch);
  if (ms == null) return null;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/**
 * The relationship state for a contact, from real fields only.
 *
 * Deliberately does not return "you owe a reply" or "waiting on her" — see the
 * file header. If you are here to add them, you need a direction field first.
 */
export function relationshipState(
  contact: Pick<ContactPayload, "lastInteraction" | "interactionCount">,
  now: number,
): RelationshipState {
  const days = daysSince(contact.lastInteraction, now);
  const exchanges = contact.interactionCount ?? 0;

  if (days == null || exchanges <= 0) {
    return {
      id: "new",
      label: "No exchanges yet",
      tone: "neutral",
      days: null,
    };
  }
  if (days >= QUIET_AFTER_DAYS && exchanges >= QUIET_MIN_EXCHANGES) {
    return {
      id: "quiet",
      // Design's HQ sentence minus the half it can't support: "asked twice"
      // needs question detection that does not exist. The day count is the
      // evidence, and it is the same number the row below the chip shows.
      label: `Going quiet · ${days} ${days === 1 ? "day" : "days"}`,
      tone: "warn",
      days,
    };
  }
  if (days <= ACTIVE_WITHIN_DAYS) {
    return { id: "active", label: "Active", tone: "neutral", days };
  }
  return { id: "known", label: "In touch", tone: "neutral", days };
}

/** "2h" / "3d" / "5mo" — the compact last-contact stat in F4's tile row. */
export function compactAgo(
  epoch: number | null | undefined,
  now: number,
): string | null {
  const ms = toMs(epoch);
  if (ms == null) return null;
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

// ── What Cue has learned ────────────────────────────────────────────────────

export type LearnedSummary =
  | {
      status: "loading";
    }
  | {
      /** The fetch failed. An error is not an empty result. */
      status: "error";
      sentence: string;
    }
  | {
      /** Extraction runs and writes nothing — the daemon says so itself. */
      status: "degraded";
      sentence: string;
      reason: string | null;
    }
  | {
      /** Pipeline healthy (or unread), genuinely nothing written yet. */
      status: "empty";
      sentence: string;
    }
  | {
      status: "learned";
      /** The statements as prose — real rows, joined, nothing generated. */
      prose: string;
      statements: string[];
      /** "From 47 exchanges · first learned Jul 12", or null when unknowable. */
      provenance: string | null;
    };

export interface LearnedInput {
  isLoading: boolean;
  isError: boolean;
  /**
   * The daemon's per-contact verdict when the rows came from a bulk read.
   * `unavailable` is "we could not look" and must never render as "nothing
   * learned yet" — zero rows is the shape both outcomes share, and the status
   * is the only thing that tells them apart.
   */
  readStatus?: ContactMemoryReadEntry["status"];
  /** The daemon's own words for why it could not look. */
  unavailableReason?: string | null;
  memory: ContactMemoryRow[] | undefined;
  /** `peopleMemoryHealth.degraded`. `undefined` = the health read itself failed. */
  degraded: boolean | undefined;
  degradedReason: string | null | undefined;
  /** Real exchange count from the contact row, for provenance. */
  interactionCount: number;
  displayName: string;
}

/**
 * Turn a contact's memory rows into exactly one of the four honest outcomes.
 *
 * The ordering is the whole point: error is checked before empty, and degraded
 * before empty, so a screen can never say "nothing yet" about a pipeline that
 * is failing or a request that never landed.
 */
export function learnedSummary(input: LearnedInput): LearnedSummary {
  const { displayName } = input;
  const first = displayName.trim().split(/\s+/)[0] || displayName;

  if (input.isError) {
    return {
      status: "error",
      sentence: `Cue couldn't load what it knows about ${first}. This is a failed request, not an empty one — what's here may be incomplete.`,
    };
  }
  if (input.isLoading) return { status: "loading" };

  if (input.readStatus === "unavailable") {
    const why = input.unavailableReason?.trim();
    return {
      status: "error",
      sentence: `Cue couldn't look up what it knows about ${first}${
        why ? ` — ${why}` : ""
      }. This is a failed request, not an empty one: it hasn't learned nothing, it couldn't look.`,
    };
  }

  const rows = input.memory ?? [];
  if (rows.length === 0) {
    if (input.degraded === true) {
      return {
        status: "degraded",
        sentence: `Cue is reading your channels but learning nothing about the people in them, so there is nothing here about ${first} — it is not hiding anything.`,
        reason: input.degradedReason ?? null,
      };
    }
    return {
      status: "empty",
      sentence: `Cue hasn't learned anything durable about ${first} yet. It writes here when an exchange says something that will still be true next month.`,
    };
  }

  const statements = rows
    .map((r) => r.statement.trim())
    .filter((s) => s.length > 0);

  return {
    status: "learned",
    prose: asProse(statements),
    statements,
    provenance: provenanceLine(input.interactionCount, rows),
  };
}

/**
 * The same four outcomes, from one contact's slot in a bulk read.
 *
 * The case worth naming: a contact that was **requested and is missing from a
 * successful response** is `unavailable`, not `empty`. We asked about them and
 * got no answer back, which is a failure to look — reading it as "nothing
 * learned" would invent a fact about a person out of a gap in a payload.
 */
export function learnedSummaryFromBulk(params: {
  entry: ContactMemoryReadEntry | undefined;
  isLoading: boolean;
  isError: boolean;
  degraded: boolean | undefined;
  degradedReason: string | null | undefined;
  interactionCount: number;
  displayName: string;
}): LearnedSummary {
  const { entry, isLoading, isError } = params;
  const base = {
    degraded: params.degraded,
    degradedReason: params.degradedReason,
    interactionCount: params.interactionCount,
    displayName: params.displayName,
  };

  if (isError) {
    return learnedSummary({
      ...base,
      isLoading: false,
      isError: true,
      memory: undefined,
    });
  }
  if (isLoading) {
    return learnedSummary({
      ...base,
      isLoading: true,
      isError: false,
      memory: undefined,
    });
  }
  if (!entry) {
    return learnedSummary({
      ...base,
      isLoading: false,
      isError: false,
      readStatus: "unavailable",
      unavailableReason: "Cue answered without this person in the reply",
      memory: undefined,
    });
  }
  return learnedSummary({
    ...base,
    isLoading: false,
    isError: false,
    readStatus: entry.status,
    unavailableReason: entry.reason,
    memory: entry.memory,
  });
}

/** Join real statements into a paragraph. Adds punctuation, never words. */
export function asProse(statements: string[]): string {
  return statements.map((s) => (/[.!?]$/.test(s) ? s : `${s}.`)).join(" ");
}

/**
 * "From 47 exchanges · first learned Jul 12". Each half is dropped when the
 * number behind it isn't real, so the line is never padded to look complete.
 */
export function provenanceLine(
  interactionCount: number,
  rows: ContactMemoryRow[],
): string | null {
  const parts: string[] = [];
  if (interactionCount > 0) {
    parts.push(
      `From ${interactionCount} ${interactionCount === 1 ? "exchange" : "exchanges"}`,
    );
  }
  const earliest = rows
    .map((r) => toMs(r.createdAt))
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b)[0];
  if (earliest != null) {
    const d = new Date(earliest);
    if (!Number.isNaN(d.getTime())) {
      parts.push(
        `${parts.length > 0 ? "first learned" : "First learned"} ${d.toLocaleDateString(
          undefined,
          { month: "short", day: "numeric" },
        )}`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ── List helpers ────────────────────────────────────────────────────────────

/** Initials for the avatar disc. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Avatar grounds. Every value is an `-on-fill` leg, because these discs carry
 * white text — a coloured fill under white text is a text context and takes
 * the darker stop. Design darkened M3's teal avatar to #0A6A6A for exactly
 * this reason; the rest follow.
 */
export const AVATAR_GROUNDS = [
  "#611F69",
  "#2B53C4", // accent-on-fill
  "#0A6A6A", // teal-on-fill
  "#8A5A08", // amber-on-fill
  "#534AB7", // violet-on-fill
] as const;

export function avatarGround(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  return AVATAR_GROUNDS[h % AVATAR_GROUNDS.length]!;
}

/** The subtitle under a name: role/company when the daemon has one. */
export function contactSubtitle(contact: ContactPayload): string | null {
  const bits = [contact.contactType, contact.role]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0 && v !== "contact" && v !== "human");
  return bits.length > 0 ? bits.join(" · ") : null;
}

/**
 * People, minus you and the assistant, newest exchange first.
 * Relationship memory is about other people.
 */
export function browsablePeople(
  contacts: ContactPayload[] | undefined,
): ContactPayload[] {
  const list = (contacts ?? []).filter(
    (c) => c.role !== "assistant" && c.role !== "guardian",
  );
  return [...list].sort(
    (a, b) =>
      (toMs(b.lastInteraction) ?? 0) - (toMs(a.lastInteraction) ?? 0) ||
      b.interactionCount - a.interactionCount,
  );
}
