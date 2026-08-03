/**
 * Mv3LibrarySheet — Library's second door (v24 F1): a sheet that rises over
 * whatever you are doing.
 *
 * The rule it satisfies: a surface earns a sheet when you need it WITHOUT
 * leaving what you're doing. "Where's that file" happens mid-task constantly,
 * and the answer costing you your place is the whole problem. So the sheet
 * opens contextually and says so — from a thing, that thing's files lead
 * ("FROM RENEW ACME · 4") and everything else follows; from the composer,
 * newest first. Swipe down returns; nothing is lost, because nothing was
 * navigated away from.
 *
 * Stage two is a PUSH, never a nested sheet — a sheet inside a sheet loses
 * the back gesture. So opening a card dismisses this sheet first and then
 * lands you on the artefact.
 */
import { useMemo, useState } from "react";

import { SheetShell } from "@/mobile-v3/sheet-shell";
import { haptic } from "@/utils/haptics";

import {
  LibraryFilterChips,
  LibraryFooterNote,
  LibraryGrid,
  LibrarySectionLabel,
} from "./library-gallery";
import {
  availableFilters,
  filterEntries,
  partitionByThing,
  type LibraryEntry,
  type LibraryFilter,
} from "./library-model";
import { useLibraryOutputs } from "./use-library-outputs";
import { useOpenLibraryEntry } from "./use-open-entry";

export function Mv3LibrarySheet({
  assistantId,
  open,
  onClose,
  /** The thing this was opened from — its files lead. Null = no lead. */
  contextProjectId = null,
  /** That thing's display title, for the section heading. */
  contextProjectTitle = null,
  /** projectId → title, so every card can name the thing it was made for. */
  thingTitleOf,
}: {
  assistantId: string;
  open: boolean;
  onClose: () => void;
  contextProjectId?: string | null;
  contextProjectTitle?: string | null;
  thingTitleOf: (projectId: string | null) => string | null;
}) {
  const { entries, isLoading, isError } = useLibraryOutputs(
    open ? assistantId : null,
  );
  const [filter, setFilter] = useState<LibraryFilter>("All");
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [now] = useState(() => Date.now());
  const { openEntry, previewModal } = useOpenLibraryEntry(assistantId);

  const filters = useMemo(() => availableFilters(entries), [entries]);
  const visible = useMemo(() => {
    const byKind = filterEntries(entries, filter);
    const q = search.trim().toLowerCase();
    if (!q) return byKind;
    return byKind.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.why ?? "").toLowerCase().includes(q),
    );
  }, [entries, filter, search]);

  const { fromThing, rest } = useMemo(
    () => partitionByThing(visible, contextProjectId),
    [visible, contextProjectId],
  );

  // Stage two is a push: leave the sheet before landing on the artefact.
  const open2 = (entry: LibraryEntry) => {
    onClose();
    openEntry(entry);
  };

  return (
    <>
      <SheetShell open={open} onClose={onClose} label="Library">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 19,
              fontWeight: 700,
              letterSpacing: "-0.4px",
              flex: 1,
              color: "var(--mv3-text)",
            }}
          >
            Library
          </span>
          {!isLoading && !isError ? (
            <span style={{ fontSize: 11, color: "var(--mv3-muted)" }}>
              {entries.length}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={searching ? "Close search" : "Search the library"}
            aria-expanded={searching}
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setSearching((s) => !s);
              if (searching) setSearch("");
            }}
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              color: "var(--mv3-muted)",
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "inherit",
              flexShrink: 0,
            }}
          >
            {searching ? "✕" : "⌕"}
          </button>
        </div>

        {searching ? (
          <input
            autoFocus
            type="text"
            aria-label="Search what Cue made"
            placeholder="Search what Cue made…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              minHeight: 44,
              marginTop: 10,
              fontSize: 16,
              padding: "9px 13px",
              borderRadius: 12,
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              color: "var(--mv3-text)",
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        ) : null}

        <div style={{ marginTop: 11 }}>
          <LibraryFilterChips
            filters={filters}
            active={filter}
            onPick={setFilter}
          />
        </div>

        <div style={{ marginTop: 13 }}>
          {isLoading ? (
            <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
              Loading what Cue made…
            </div>
          ) : isError ? (
            /* A failed fetch is an error state, never an empty gallery. */
            <div style={{ fontSize: 12.5, color: "var(--mv3-fail-text)" }}>
              I couldn’t load your library just now. Nothing is lost — swipe
              down and try again in a moment.
            </div>
          ) : visible.length === 0 ? (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--mv3-muted)",
                lineHeight: 1.5,
              }}
            >
              {search.trim()
                ? `Nothing Cue made matches “${search.trim()}”.`
                : filter !== "All"
                  ? `Cue hasn’t made anything filed under ${filter} yet.`
                  : "Nothing here yet — everything Cue makes for you lands in the Library, with the thing it was made for on it."}
            </div>
          ) : (
            <>
              {fromThing.length > 0 ? (
                <div style={{ marginBottom: 15 }}>
                  <LibrarySectionLabel>
                    {`FROM ${(contextProjectTitle ?? "THIS THING").toUpperCase()} · ${fromThing.length}`}
                  </LibrarySectionLabel>
                  <LibraryGrid
                    assistantId={assistantId}
                    entries={fromThing}
                    thingTitleOf={thingTitleOf}
                    now={now}
                    coverHeight={70}
                    onOpen={open2}
                  />
                </div>
              ) : null}
              {rest.length > 0 ? (
                <div>
                  <LibrarySectionLabel>
                    {fromThing.length > 0 ? "EVERYTHING ELSE" : "EVERYTHING"}
                  </LibrarySectionLabel>
                  <LibraryGrid
                    assistantId={assistantId}
                    entries={rest.slice(0, 40)}
                    thingTitleOf={thingTitleOf}
                    now={now}
                    coverHeight={70}
                    onOpen={open2}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* The share line is computed from this shell's reach and the cards
            actually on screen (LibraryFooterNote), so it can never promise a
            sheet the phone cannot open. The sheet's own promise follows it. */}
        {visible.length > 0 && !isError ? (
          <LibraryFooterNote entries={visible} style={{ paddingTop: 13 }} />
        ) : null}
        <div
          style={{
            padding:
              visible.length > 0 && !isError ? "5px 0 4px" : "13px 0 4px",
            fontSize: 10.5,
            color: "var(--mv3-faint)",
            textAlign: "center",
          }}
        >
          Swipe down to go back · nothing lost
        </div>
      </SheetShell>
      {previewModal}
    </>
  );
}
