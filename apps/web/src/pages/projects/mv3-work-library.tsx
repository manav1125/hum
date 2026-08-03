/**
 * Mv3WorkLibrary — Work's THIRD view (v23 C3), the phone's Library
 * destination.
 *
 * The ruling this implements: Library is no longer a tab. Desktop already
 * lists Things · Everything · Files inside one destination, and Library IS
 * work output, so it belongs inside the tab called Work rather than competing
 * with it. It keeps its gallery form exactly — 2-col, agent and thing on every
 * card. Filed, not demoted.
 *
 * The header line still carries the argument: "48 things Cue made · 11 this
 * week" — a plain count of real deliverables, not a folder size.
 *
 * DATA: `GET /outputs` (see library-model.ts for why it, and not the desktop
 * Library's apps/documents/attachments, is the only source that can put the
 * agent AND the thing on a card).
 */
import { useMemo, useRef, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { AuroraBackdrop } from "@/mobile-v3";
import {
  LibraryFilterChips,
  LibraryGrid,
  LibrarySectionLabel,
} from "@/mobile-v3/library/library-gallery";
import {
  availableFilters,
  filterEntries,
  groupByRecency,
  madeLine,
  type LibraryFilter,
} from "@/mobile-v3/library/library-model";
import { useLibraryOutputs } from "@/mobile-v3/library/use-library-outputs";
import { useOpenLibraryEntry } from "@/mobile-v3/library/use-open-entry";
import { WorkHeader } from "@/mobile-v3/work-kit";
import { haptic } from "@/utils/haptics";

import { useProjects } from "./use-projects";

export function Mv3WorkLibrary() {
  const assistantId = useActiveAssistantId();
  useActivitySync(assistantId, true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  const [filter, setFilter] = useState<LibraryFilter>("All");
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");

  const { entries, isLoading, isError } = useLibraryOutputs(assistantId);
  const { projects } = useProjects(assistantId);
  const { openEntry, previewModal } = useOpenLibraryEntry(assistantId);

  const thingTitleOf = useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.title]));
    return (projectId: string | null) =>
      projectId ? (map.get(projectId) ?? null) : null;
  }, [projects]);

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

  const sections = useMemo(() => groupByRecency(visible, now), [visible, now]);

  return (
    <div
      data-mv3
      data-slot="mv3-work-library"
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />

      <div
        style={{
          height: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 8px)",
          flexShrink: 0,
        }}
      />

      <WorkHeader
        assistantId={assistantId}
        current="library"
        countsOverride={
          isLoading || isError ? " " : madeLine(entries, now)
        }
        trailing={
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
              borderRadius: 10,
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
        }
      />

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "4px 14px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
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
              marginBottom: 10,
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

        <div style={{ marginBottom: 11 }}>
          <LibraryFilterChips
            filters={filters}
            active={filter}
            onPick={setFilter}
          />
        </div>

        {isLoading ? (
          <div style={{ fontSize: 13, color: "var(--mv3-muted)" }}>
            Loading what Cue made…
          </div>
        ) : isError ? (
          /* A failed fetch is an error state, not an empty gallery — saying
             "nothing here" about work you actually have is the worse lie. */
          <div
            style={{
              fontSize: 13,
              color: "var(--mv3-fail-text)",
              lineHeight: 1.5,
            }}
          >
            I couldn’t load your library just now — nothing has been lost. Pull
            down or try again in a moment.
          </div>
        ) : visible.length === 0 ? (
          <div
            style={{
              fontSize: 13,
              color: "var(--mv3-muted)",
              lineHeight: 1.55,
              padding: "6px 2px",
            }}
          >
            {search.trim()
              ? `Nothing Cue made matches “${search.trim()}”.`
              : filter !== "All"
                ? `Cue hasn’t made anything filed under ${filter} yet — the chip is here because other kinds exist.`
                : "Nothing here yet. Everything Cue makes for you lands in the Library, tagged with the agent that made it and the thing it was made for."}
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.key} style={{ marginBottom: 16 }}>
              <LibrarySectionLabel>{section.key}</LibrarySectionLabel>
              <LibraryGrid
                assistantId={assistantId}
                entries={section.entries}
                thingTitleOf={thingTitleOf}
                now={now}
                onOpen={openEntry}
              />
            </div>
          ))
        )}

        {visible.length > 0 ? (
          <div
            style={{
              fontSize: 10,
              color: "var(--mv3-faint)",
              textAlign: "center",
              marginTop: 11,
              lineHeight: 1.5,
            }}
          >
            Tap opens it here.
          </div>
        ) : null}
      </div>

      {previewModal}
    </div>
  );
}
