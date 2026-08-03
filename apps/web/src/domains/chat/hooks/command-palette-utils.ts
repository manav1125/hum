/** Pure helper functions for command palette section building — and for the
 *  two sentences the palette says when it has no sections to build.
 *
 *  Those two are separate on purpose. `searchNoticeFor` speaks for a search
 *  that FAILED; `emptyResultsMessage` speaks for a search that RAN and found
 *  nothing, and returns null rather than speak over a failure. Keeping them
 *  apart is what stops a 500 from reading as "you have nothing".
 *
 *  Separated from the React hook (`useCommandPaletteSections`) so they
 *  can be unit-tested without a component render cycle. */

import { Calendar, Contact, MessageSquare } from "lucide-react";

import type { CommandPaletteSection } from "@/components/command-palette/command-palette";
import type {
  GlobalSearchOutcome,
  GlobalSearchResponse,
  SearchCategory,
} from "@/domains/chat/api/global-search";
import { describeCategories } from "@/domains/chat/api/global-search";

/**
 * The palette renders three of the four searchable categories — there is no
 * memory row in `buildServerResultSections`, so asking for memories would be
 * payload nobody reads. Exported so the request and the "here's what I looked
 * through" sentence can never drift apart.
 */
export const PALETTE_SEARCH_CATEGORIES: readonly SearchCategory[] = [
  "conversations",
  "schedules",
  "contacts",
];

/**
 * What the palette says when the list is empty.
 *
 * An empty result must still say WHY it is empty, and it must never be the
 * thing a failed search falls back to — a failure is rendered by
 * `searchNoticeFor` instead, and this function refuses to speak for one.
 */
export function emptyResultsMessage(input: {
  query: string;
  isSearching: boolean;
  outcome: GlobalSearchOutcome | null | undefined;
  minQueryLength: number;
}): string | null {
  const { query, isSearching, outcome, minQueryLength } = input;
  const trimmed = query.trim();
  const searched = describeCategories(PALETTE_SEARCH_CATEGORIES);

  if (isSearching) return "Searching…";

  // A failure already has its own red line above the list. Saying "nothing
  // matched" underneath it would be the exact lie this module exists to stop.
  if (outcome?.status === "error" || outcome?.status === "unavailable") {
    return null;
  }

  if (!trimmed) return "Nothing to show yet.";

  if (outcome?.status === "ok") {
    return `Nothing matched “${trimmed}”. I searched your ${searched}.`;
  }

  if (trimmed.length < minQueryLength) {
    return `Nothing here matched “${trimmed}”. Type ${minQueryLength} characters and I'll search your ${searched} too.`;
  }

  return `Nothing matched “${trimmed}”.`;
}

/** A line the palette shows above the results, and how loud it should be. */
export interface SearchNotice {
  /** `error` is Cue reporting its own failure — red is reserved for this. */
  tone: "error" | "muted";
  message: string;
}

/**
 * Turn an outcome into the line the user reads. `ok` and `cancelled` produce
 * nothing: one has results to show, the other never searched and is about to be
 * replaced by the search that superseded it.
 */
export function searchNoticeFor(
  outcome: GlobalSearchOutcome | null | undefined,
): SearchNotice | null {
  if (!outcome) return null;
  switch (outcome.status) {
    case "error":
      return { tone: "error", message: outcome.message };
    case "unavailable":
      return { tone: "muted", message: outcome.message };
    default:
      return null;
  }
}

/**
 * Build sections from server search results, deduplicating conversations
 * that already appear in the local recents section.
 */
export function buildServerResultSections(
  results: GlobalSearchResponse,
  recentConversationIds: Set<string>,
): CommandPaletteSection[] {
  const sections: CommandPaletteSection[] = [];

  const serverConvItems = results.conversations
    .filter((c) => !recentConversationIds.has(c.id))
    .map((c) => ({
      id: `search-conv-${c.id}`,
      icon: MessageSquare,
      title: c.title ?? "Untitled",
      subtitle: c.excerpt,
    }));
  if (serverConvItems.length > 0) {
    sections.push({
      id: "search-conversations",
      label: "Conversations",
      items: serverConvItems,
    });
  }

  const scheduleItems = results.schedules.map((s) => ({
    id: `search-schedule-${s.id}`,
    icon: Calendar,
    title: s.name,
    subtitle: s.expression ?? s.message,
  }));
  if (scheduleItems.length > 0) {
    sections.push({
      id: "search-schedules",
      label: "Schedules",
      items: scheduleItems,
    });
  }

  const contactItems = results.contacts.map((c) => ({
    id: `search-contact-${c.id}`,
    icon: Contact,
    title: c.displayName,
    subtitle: c.notes ?? undefined,
  }));
  if (contactItems.length > 0) {
    sections.push({
      id: "search-contacts",
      label: "Contacts",
      items: contactItems,
    });
  }

  return sections;
}
