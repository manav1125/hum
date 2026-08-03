/**
 * The Library's gallery — the 2-col wall of real output that both doors
 * render (v23 C3 · v24 F1).
 *
 * "Filed, not demoted": losing a tab slot changed where Library lives, not
 * what it looks like. Every card carries the two facts the frame insists on —
 * the agent that made it and the thing it was made for — because a wall of
 * files with neither is a folder, and a folder is not work output.
 *
 * Covers: an image-backed output shows its REAL bytes (the attachment content
 * route). Everything else gets a kind-typed cover carrying the kind glyph —
 * a drawn placeholder, never a fake preview of a document nobody rendered.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";
import { mv3Mono } from "@/mobile-v3/mv3-kit";
import { haptic } from "@/utils/haptics";

import {
  cardMeta,
  entryDate,
  kindGlyph,
  type LibraryEntry,
  type LibraryFilter,
} from "./library-model";

/* -------------------------------------------------------------------------- */
/* Covers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Kind-typed cover grounds, lifted off the C3/F1 frames. These are ART — flat
 * gradients behind a glyph — so they carry no text and never enter the
 * `-on-fill` text rule.
 */
const COVER_ART: Record<string, string> = {
  deck: "linear-gradient(160deg,#1A2230,#3D6EE8)",
  spreadsheet: "linear-gradient(160deg,#123B2E,#0B2018)",
  document: "linear-gradient(160deg,#242A38,#171C27)",
  pdf: "linear-gradient(160deg,#2E2230,#1C151E)",
  image: "linear-gradient(140deg,#2B3A5C,#3D2B5C)",
  video: "linear-gradient(140deg,#20303F,#141C26)",
  other: "linear-gradient(160deg,#232A36,#181D26)",
};

/**
 * Real bytes for an image-backed output. Kept to images only: a PDF or a deck
 * would need a renderer, and a blank rectangle labelled "preview" is worse
 * than an honest kind glyph.
 */
function useImageCover(
  assistantId: string,
  entry: LibraryEntry,
): string | null {
  const attachmentId =
    entry.kind === "image" && entry.attachment ? entry.attachment.id : null;
  const query = useQuery({
    queryKey: ["mv3-library-cover", assistantId, attachmentId],
    enabled: Boolean(assistantId && attachmentId),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data } = await attachmentsByIdContentGet({
        path: { assistant_id: assistantId, id: attachmentId ?? "" },
        parseAs: "blob",
        throwOnError: true,
      });
      return data as unknown as Blob;
    },
  });
  const blob = query.data ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url;
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export function LibraryCard({
  assistantId,
  entry,
  thingTitle,
  now,
  coverHeight = 88,
  onOpen,
}: {
  assistantId: string;
  entry: LibraryEntry;
  /** The thing it was made for; null when the output was never filed. */
  thingTitle: string | null;
  now: number;
  /** 88 in the destination (C3), 70 in the sheet (F1). */
  coverHeight?: number;
  onOpen: (entry: LibraryEntry) => void;
}) {
  const cover = useImageCover(assistantId, entry);
  const open = () => {
    haptic.light();
    onOpen(entry);
  };
  return (
    <div
      data-mv3
      role="button"
      tabIndex={0}
      className="cue-pressable"
      aria-label={`${entry.title} — made by ${cardMeta(entry, thingTitle)}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      style={{
        borderRadius: 14,
        overflow: "hidden",
        border: "1px solid var(--mv3-card-border)",
        background: "var(--mv3-card)",
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <div
        aria-hidden
        style={{
          height: coverHeight,
          background: COVER_ART[entry.kind] ?? COVER_ART.other,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: mv3Mono,
              fontSize: 20,
              color: "rgba(255,255,255,.62)",
            }}
          >
            {kindGlyph(entry.kind)}
          </span>
        )}
        {/* Not yet approved is a fact about the artefact, so it rides the
            cover with a glyph — never colour alone. */}
        {entry.reviewState === "pending" ? (
          <span
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              fontFamily: mv3Mono,
              fontSize: 8.5,
              letterSpacing: "0.08em",
              padding: "2px 5px",
              borderRadius: 5,
              background: "rgba(0,0,0,.55)",
              color: "#F2D9A6",
            }}
          >
            ‖ REVIEW
          </span>
        ) : null}
      </div>
      <div style={{ padding: "8px 10px" }}>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--mv3-text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {entry.title}
        </div>
        <div
          style={{
            fontSize: 9,
            color: "var(--mv3-faint)",
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {cardMeta(entry, thingTitle)} · {entryDate(entry, now)}
        </div>
      </div>
    </div>
  );
}

/** The 2-col wall. */
export function LibraryGrid({
  assistantId,
  entries,
  thingTitleOf,
  now,
  coverHeight,
  onOpen,
}: {
  assistantId: string;
  entries: LibraryEntry[];
  thingTitleOf: (projectId: string | null) => string | null;
  now: number;
  coverHeight?: number;
  onOpen: (entry: LibraryEntry) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 9,
      }}
    >
      {entries.map((entry) => (
        <LibraryCard
          key={entry.id}
          assistantId={assistantId}
          entry={entry}
          thingTitle={thingTitleOf(entry.projectId)}
          now={now}
          coverHeight={coverHeight}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

/** The kind chip row — only chips with something behind them. */
export function LibraryFilterChips({
  filters,
  active,
  onPick,
}: {
  filters: LibraryFilter[];
  active: LibraryFilter;
  onPick: (filter: LibraryFilter) => void;
}) {
  if (filters.length <= 1) return null;
  return (
    <div
      role="radiogroup"
      aria-label="Filter by kind"
      style={{
        display: "flex",
        gap: 5,
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        paddingBottom: 2,
      }}
    >
      {filters.map((f) => {
        const selected = f === active;
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={selected}
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              onPick(f);
            }}
            style={{
              fontSize: 11,
              fontWeight: selected ? 600 : 400,
              color: selected ? "var(--mv3-bg)" : "var(--mv3-muted)",
              background: selected ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
              border: selected
                ? "1px solid transparent"
                : "1px solid var(--mv3-btn2-border)",
              borderRadius: 99,
              padding: "6px 12px",
              minHeight: 32,
              whiteSpace: "nowrap",
              flexShrink: 0,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {f}
          </button>
        );
      })}
    </div>
  );
}

/** Mono section heading ("THIS WEEK", "FROM RENEW ACME · 4"). */
export function LibrarySectionLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: mv3Mono,
        fontSize: 8.5,
        letterSpacing: "0.11em",
        textTransform: "uppercase",
        color: "var(--mv3-faint)",
        padding: "0 2px 7px",
      }}
    >
      {children}
    </div>
  );
}
