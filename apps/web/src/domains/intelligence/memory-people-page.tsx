/**
 * **People**, as the interim tab under `Your Cue → Memory`.
 *
 * Design's sequencing ruling, verbatim: *"ship it inside `Your Cue → Memory`
 * as an interim tab. Promote it to the sidebar when contact memories are
 * non-zero and growing week-over-week — not when the code ships. A prominent
 * destination with 2 rows teaches people the slot is worthless."* The sidebar
 * gate (`shouldShowPeopleRow`) was built and this half was not, so People had
 * no door at all. The gate is untouched; this is the missing door.
 *
 * ## The surface (v19 frame N2)
 *
 * Three columns — **who** · **what Cue has learned, in plain sentences not
 * fields** · **relationship state** — with filters and an honest footer.
 *
 * ## What the data supports, and what it does not
 *
 * This is the part that matters, because the alternative is a screen that
 * looks finished and is lying.
 *
 * | Design asks for | Status |
 * |---|---|
 * | Who — name | `contact.displayName` ✓ |
 * | Who — **org · role** | **no field exists.** A contact carries `role` (a free string) and channels. No company, no job title. Shown as the primary channel instead, which is true. |
 * | What Cue has learned | `GET /contacts/:id/memory` ✓ — and on this instance it returns nothing for anybody, which the header says out loud rather than rendering blank rows |
 * | **Owe them a reply** | **not derivable.** Nothing on any per-contact interaction records a direction, so "who spoke last" is unknown. The filter renders disabled with the reason rather than being quietly dropped — a missing filter reads as an oversight; a disabled one reads as a gap. |
 * | Waiting on them | ✓ via work items' `waitingOn` / `waitingState` |
 * | Going quiet | ✓ derived from silence — and labelled as derived |
 * | By company | **no company field.** Disabled, with the reason. |
 *
 * ## Why the memory reads are capped
 *
 * Relationship memory is per-contact only (`use-people-signal.ts` documents the
 * same wall). Rendering N rows means N requests, so this fetches memory for the
 * rows it is actually showing, capped at {@link MEMORY_FETCH_CAP}. Rows past
 * the cap say their learned column was not read rather than showing an empty
 * one — "I did not ask" and "there is nothing" are different answers and only
 * one of them is safe to believe.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  contactsByIdMemoryGetOptions,
  contactsGetOptions,
  peopleMemoryHealthGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** How many rows get their relationship memory fetched. See the header. */
export const MEMORY_FETCH_CAP = 24;

/** Silence longer than this, from someone you have talked to, is "going quiet". */
export const GOING_QUIET_DAYS = 14;

/** "In touch this month". */
const IN_TOUCH_DAYS = 30;

const DAY_MS = 86_400_000;

type FilterKey = "all" | "in-touch" | "waiting" | "going-quiet";

interface FilterChip {
  key: FilterKey;
  label: string;
  /** Present when the filter cannot be built from data that exists. */
  unavailableReason?: string;
}

/**
 * The filter row. Two of design's five are disabled and say why.
 *
 * Keeping them visible-but-disabled is deliberate. Dropping them silently
 * would leave no record that the surface is missing a capability the design
 * asked for; a `⊘` row with a sentence is the cheapest possible monitor.
 */
const FILTERS: readonly FilterChip[] = [
  { key: "all", label: "All" },
  { key: "in-touch", label: "In touch this month" },
  { key: "waiting", label: "Waiting on them" },
  { key: "going-quiet", label: "Going quiet" },
] as const;

const DISABLED_FILTERS: readonly { label: string; reason: string }[] = [
  {
    label: "Owe them a reply",
    reason:
      "Nothing records who spoke last — no message on a contact carries a direction — so Cue cannot tell whose turn it is.",
  },
  {
    label: "By company",
    reason: "A contact has no company or job title field to group by.",
  },
] as const;

/**
 * Relationship state. Every state carries a glyph — nothing here is
 * distinguished by colour alone (v21 §8).
 */
type StateKey = "waiting" | "going-quiet" | "active" | "never";

const STATE_META: Record<
  StateKey,
  { glyph: string; label: string; title: string }
> = {
  waiting: {
    glyph: "‖",
    label: "Waiting on them",
    title: "A work item is blocked on this person.",
  },
  "going-quiet": {
    glyph: "○",
    label: "Going quiet",
    title: `No exchange in over ${GOING_QUIET_DAYS} days. Derived from silence, not from anything they said.`,
  },
  active: {
    glyph: "✓",
    label: "Active",
    title: "Exchanged something recently.",
  },
  never: {
    glyph: "⊘",
    label: "No exchange yet",
    title: "Cue has never seen a message either way.",
  },
};

interface PersonRow {
  id: string;
  name: string;
  /** Role plus the primary channel — the honest stand-in for "org · role". */
  subtitle: string;
  state: StateKey;
  lastInteraction: number | null;
  interactionCount: number;
}

function daysSince(at: number | null | undefined, now: number): number | null {
  if (at == null || !Number.isFinite(at) || at <= 0) return null;
  const ms = at < 1e12 ? at * 1000 : at;
  return (now - ms) / DAY_MS;
}

function lastSeenLabel(at: number | null, now: number): string {
  const days = daysSince(at, now);
  if (days == null) return "never";
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${Math.round(days)}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function MemoryPeoplePage() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const enabled = Boolean(assistantId);
  const path = { assistant_id: assistantId ?? "" };
  const [filter, setFilter] = useState<FilterKey>("all");
  // Captured once per mount. `Date.now()` read during render is impure and
  // would also re-bucket rows mid-interaction; relative labels on this surface
  // are day-grained, so a mount-time stamp is the right resolution.
  const [now] = useState(() => Date.now());

  const contacts = useQuery({
    ...contactsGetOptions({ path }),
    enabled,
    retry: false,
  });

  // "Waiting on them" is the one relationship state with real backing, and it
  // does not live on the contact — it lives on work items, which carry a
  // `waitingOn` contact id and a server-derived `waitingState`.
  const workItems = useQuery({
    ...workitemsGetOptions({ path }),
    enabled,
    retry: false,
  });

  // The instrumentation that would have caught 697 extractions writing nothing.
  const health = useQuery({
    ...peopleMemoryHealthGetOptions({ path }),
    enabled,
    retry: false,
  });

  const waitingOn = useMemo(() => {
    const ids = new Set<string>();
    for (const item of workItems.data?.items ?? []) {
      if (typeof item.waitingOn === "string" && item.waitingOn.length > 0) {
        ids.add(item.waitingOn);
      }
    }
    return ids;
  }, [workItems.data]);

  const people = useMemo<PersonRow[]>(() => {
    // The same exclusion the gate applies: relationship memory is about other
    // people, so Cue itself and you are not contacts for this purpose.
    const raw = (contacts.data?.contacts ?? []).filter(
      (c) => c.role !== "assistant" && c.role !== "guardian",
    );
    return raw
      .map((c) => {
        const days = daysSince(c.lastInteraction, now);
        const primary =
          c.channels.find((ch) => ch.isPrimary) ?? c.channels[0] ?? null;
        const state: StateKey = waitingOn.has(c.id)
          ? "waiting"
          : days == null
            ? "never"
            : days > GOING_QUIET_DAYS
              ? "going-quiet"
              : "active";
        return {
          id: c.id,
          name: c.displayName,
          subtitle: [c.role, primary?.address].filter(Boolean).join(" · "),
          state,
          lastInteraction: c.lastInteraction ?? null,
          interactionCount: c.interactionCount,
        };
      })
      .sort(
        (a, b) =>
          (b.lastInteraction ?? 0) - (a.lastInteraction ?? 0) ||
          b.interactionCount - a.interactionCount,
      );
  }, [contacts.data, waitingOn, now]);

  const filtered = useMemo(() => {
    if (filter === "all") return people;
    return people.filter((p) => {
      if (filter === "waiting") return p.state === "waiting";
      if (filter === "going-quiet") return p.state === "going-quiet";
      const days = daysSince(p.lastInteraction, now);
      return days != null && days <= IN_TOUCH_DAYS;
    });
  }, [people, filter, now]);

  const shown = filtered.slice(0, MEMORY_FETCH_CAP);

  const memories = useQueries({
    queries: shown.map((person) => ({
      ...contactsByIdMemoryGetOptions({ path: { ...path, id: person.id } }),
      enabled,
      retry: false,
    })),
  });

  const learnedTotal = memories.reduce(
    (total, q) => total + (q.data?.memory?.length ?? 0),
    0,
  );
  const degraded = health.data?.degraded === true;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 pb-3">
        <h2 className="text-title-medium text-[var(--content-default)]">
          People
        </h2>
        <p className="mt-1 text-body-small-default text-[var(--content-secondary)]">
          {contacts.isError
            ? "⚠ Couldn't read your contacts."
            : contacts.isPending
              ? "Reading…"
              : `${people.length} ${people.length === 1 ? "person" : "people"} · ${learnedTotal} learned ${learnedTotal === 1 ? "thing" : "things"} across the ${Math.min(shown.length, MEMORY_FETCH_CAP)} rows below`}
        </p>
      </header>

      {/*
        The no-op card. Extraction completing and extraction learning something
        are different outcomes, and until now they looked identical — 697
        completed runs that wrote nothing were invisible. If the daemon says it
        is degraded, this says so in the daemon's own words.
      */}
      {degraded ? (
        <p className="mb-3 shrink-0 rounded-[8px] border border-[var(--border-base)] px-3 py-2 text-body-small-default text-[var(--content-secondary)]">
          <span aria-hidden>⚠ </span>
          Cue is reading your channels but learning nothing about the people in
          them. {health.data?.degradedReason ??
            "The daemon did not say why."}{" "}
          Until that changes the middle column stays empty — it is not hiding
          anything.
        </p>
      ) : null}

      <div
        role="group"
        aria-label="Filter people"
        className="mb-3 flex shrink-0 flex-wrap items-center gap-1"
      >
        {FILTERS.map((chip) => {
          const isActive = filter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setFilter(chip.key)}
              className={[
                "cursor-pointer whitespace-nowrap rounded-[6px] border-none bg-transparent px-2.5 py-1",
                "text-body-small-default text-[var(--content-secondary)] transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
                isActive
                  ? "bg-[var(--surface-hover)] font-medium text-[var(--content-default)]"
                  : "",
              ].join(" ")}
            >
              {/* The selected chip carries a glyph, not just a tint. */}
              {isActive ? <span aria-hidden>▸ </span> : null}
              {chip.label}
            </button>
          );
        })}
        {DISABLED_FILTERS.map((chip) => (
          <span
            key={chip.label}
            aria-disabled="true"
            title={chip.reason}
            className="cursor-default whitespace-nowrap rounded-[6px] px-2.5 py-1 text-body-small-default text-[var(--content-secondary)]"
          >
            <span aria-hidden>⊘ </span>
            {chip.label}
            <span className="sr-only"> — {chip.reason}</span>
          </span>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {contacts.isError ? (
          <p className="px-1 py-2 text-body-small-default text-[var(--content-secondary)]">
            ⚠ Couldn&apos;t read your contacts.
          </p>
        ) : shown.length === 0 && !contacts.isPending ? (
          <p className="px-1 py-2 text-body-small-default text-[var(--content-secondary)]">
            Nobody matches that filter.
          </p>
        ) : (
          shown.map((person, index) => {
            const query = memories[index];
            const learned = query?.data?.memory ?? [];
            const state = STATE_META[person.state];
            return (
              <div
                key={person.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] items-start gap-4 border-b border-[var(--border-base)] px-1 py-3 last:border-b-0 max-md:grid-cols-1"
              >
                {/* Who. */}
                <div className="min-w-0">
                  <div className="truncate text-body-medium-default text-[var(--content-default)]">
                    {person.name}
                  </div>
                  <div className="truncate text-body-small-default text-[var(--content-secondary)]">
                    {person.subtitle || "no channel on file"}
                  </div>
                </div>

                {/* What Cue has learned — plain sentences, not fields. */}
                <div className="min-w-0 text-body-small-default text-[var(--content-secondary)]">
                  {query?.isError ? (
                    <span>⚠ Couldn&apos;t read what Cue has learned.</span>
                  ) : query?.isPending ? (
                    <span>Reading…</span>
                  ) : learned.length === 0 ? (
                    <span>
                      <span aria-hidden>— </span>Nothing learned yet.
                    </span>
                  ) : (
                    <span>{learned.map((m) => m.statement).join(" ")}</span>
                  )}
                </div>

                {/* Relationship state. */}
                <div className="shrink-0 text-right text-body-small-default text-[var(--content-secondary)]">
                  <div title={state.title}>
                    <span aria-hidden>{state.glyph} </span>
                    {state.label}
                  </div>
                  <div>
                    {person.interactionCount}{" "}
                    {person.interactionCount === 1 ? "exchange" : "exchanges"} ·{" "}
                    {lastSeenLabel(person.lastInteraction, now)}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {filtered.length > shown.length ? (
          <p className="px-1 py-2 text-body-small-default text-[var(--content-secondary)]">
            <span aria-hidden>⊘ </span>
            {filtered.length - shown.length} more not shown. What Cue has
            learned is only readable one person at a time, so this surface stops
            at {MEMORY_FETCH_CAP} rather than making a request per row.
          </p>
        ) : null}
      </div>

      <footer className="mt-3 shrink-0 border-t border-[var(--border-base)] pt-2 text-body-small-default text-[var(--content-secondary)]">
        <p>
          <span aria-hidden>✧ </span>
          Cue learns these from your channels — nothing here was typed in by
          hand.
        </p>
        <p className="mt-1">
          <span aria-hidden>⊘ </span>
          No company or job title is recorded against a contact, and nothing
          records who spoke last — so there is no “org · role” line and no “owe
          them a reply”. “Going quiet” is derived from {GOING_QUIET_DAYS} days
          of silence, not from anything anyone said.
        </p>
      </footer>
    </div>
  );
}
