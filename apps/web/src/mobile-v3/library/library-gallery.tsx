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
 *
 * Share: the ⇪ on a cover is C3's footer promise, and it appears ONLY on
 * cards that have something behind it in the shell you are actually holding
 * (see library-share.ts). No reach, or nothing to send, and there is no
 * button — a ⇪ that opens an empty sheet is worse than one that isn't there.
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
  libraryScopeNote,
  type LibraryEntry,
  type LibraryFilter,
} from "./library-model";
import {
  detectShareReach,
  entryShareMode,
  shareFooterLine,
  type ShareReach,
} from "./library-share";
import { useLibraryShare } from "./use-library-share";

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
  app: "linear-gradient(150deg,#2A2036,#3B2A6B)",
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
  reach = "none",
  sharing = false,
  onShare,
}: {
  assistantId: string;
  entry: LibraryEntry;
  /** The thing it was made for; null when the output was never filed. */
  thingTitle: string | null;
  now: number;
  /** 88 in the destination (C3), 70 in the sheet (F1). */
  coverHeight?: number;
  onOpen: (entry: LibraryEntry) => void;
  /** What the shell can do. "none" (the default) renders no ⇪ at all. */
  reach?: ShareReach;
  /** Mid-share, so the one tapped card dims rather than the whole wall. */
  sharing?: boolean;
  onShare?: (entry: LibraryEntry) => void;
}) {
  const cover = useImageCover(assistantId, entry);
  const shareMode = onShare ? entryShareMode(entry, reach) : null;
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
        {/* C3's ⇪. Rendered only where it leads somewhere: `entryShareMode`
            is null for an output with no bytes and no URL, and for every
            output when the shell has no share reach at all. */}
        {shareMode ? (
          <button
            type="button"
            aria-label={
              shareMode === "file"
                ? `Share ${entry.title}`
                : `Share a link to ${entry.title}`
            }
            aria-busy={sharing}
            disabled={sharing}
            className="cue-pressable"
            onClick={(e) => {
              // The cover is inside the card's own open handler; sharing is
              // not opening.
              e.stopPropagation();
              onShare?.(entry);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              right: 5,
              bottom: 5,
              width: 30,
              height: 30,
              borderRadius: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              // A translucent scrim over the cover art, which is always one of
              // the dark COVER_ART gradients or a photo — white ink on it
              // clears the floor in both themes.
              background: "rgba(0,0,0,.55)",
              border: "1px solid rgba(255,255,255,.16)",
              color: "#FFFFFF",
              fontSize: 13,
              lineHeight: 1,
              cursor: sharing ? "default" : "pointer",
              fontFamily: "inherit",
              opacity: sharing ? 0.55 : 1,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {sharing ? "…" : "⇪"}
          </button>
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

/**
 * The 2-col wall. It owns the share state itself — every surface that renders
 * a grid gets the working ⇪ without wiring anything, and every card in one
 * grid shares one busy id and one failure pill.
 *
 * `share={false}` opts a surface out entirely; there is no way to opt into a
 * ⇪ that cannot do anything, because the reach probe is the only thing that
 * decides whether one is drawn.
 */
export function LibraryGrid({
  assistantId,
  entries,
  thingTitleOf,
  now,
  coverHeight,
  onOpen,
  share = true,
}: {
  assistantId: string;
  entries: LibraryEntry[];
  thingTitleOf: (projectId: string | null) => string | null;
  now: number;
  coverHeight?: number;
  onOpen: (entry: LibraryEntry) => void;
  share?: boolean;
}) {
  const { reach, sharingId, shareEntry, shareToast } =
    useLibraryShare(assistantId);
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
          reach={share ? reach : "none"}
          sharing={sharingId === entry.id}
          onShare={share ? shareEntry : undefined}
        />
      ))}
      {share ? shareToast : null}
    </div>
  );
}

/**
 * The gallery's footer note — C3's line, computed rather than written down.
 *
 * It takes the entries the wall is SHOWING, so it can never promise a share
 * for outputs that are not there, and it reads the same reach the ⇪ reads, so
 * the sentence and the button can never disagree. On a shell with no share at
 * all it degrades to the one thing that is always true: tap opens it here.
 *
 * It also carries the SCOPE line. The header counts what this list holds; only
 * this says what it does not, and where that lives instead. The two belong to
 * one claim, so they are shipped together rather than left for each surface to
 * remember.
 */
export function LibraryFooterNote({
  entries,
  style,
}: {
  entries: LibraryEntry[];
  style?: React.CSSProperties;
}) {
  const [reach] = useState<ShareReach>(() => detectShareReach());
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--mv3-faint)",
        textAlign: "center",
        lineHeight: 1.5,
        ...style,
      }}
    >
      <div>{libraryScopeNote}</div>
      <div>{shareFooterLine(reach, entries)}</div>
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
