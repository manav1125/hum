/**
 * Mobile v3 Create — J2, the scoped gallery.
 *
 * Design: *"1c is scoped, never global. You arrive filtered to Slides or Docs;
 * type chips switch without going back."*
 *
 * Two structural consequences, both enforced here rather than by convention:
 *
 * - The component takes a required `typeId`. There is no prop that produces an
 *   unscoped gallery, so one cannot be rendered by mistake.
 * - The type chips call `onSwitchType`, which re-scopes IN PLACE. They do not
 *   pop the stack, so changing your mind costs one tap rather than a back-and-
 *   forward.
 *
 * Rule 6 — "Blank is first-class" — is why the blank cell is the third child of
 * the same grid rather than a link under it. It is the same size as a template
 * card and sits above the "N more" overflow.
 */

import { haptic } from "@/utils/haptics";

import {
  galleryEntriesFor,
  getCreateType,
  MV3_CREATE_TYPES,
  type Mv3GalleryEntry,
} from "./create-types";

import "./mv3-create.css";

/** How many templates a phone grid shows before the overflow cell. */
const VISIBLE = 5;

export interface CreateGalleryProps {
  typeId: string;
  onSwitchType: (typeId: string) => void;
  onPickTemplate: (templateId: string) => void;
  /** Blank — describe it instead of picking. */
  onBlank: () => void;
  /** Show the rest of this type's templates. */
  onShowAll: () => void;
  /** Whether every template is already visible (hides the overflow cell). */
  showingAll?: boolean;
}

/**
 * A template card's structural preview.
 *
 * Deliberately schematic. The registry does carry real thumbnail PNGs for the
 * 18 deck templates, but the form/quick-start entries this grid lists are not
 * those specs — so rendering a deck thumbnail against an arbitrary entry would
 * show the user a picture of a different template. Structure it is.
 */
function CardPreview({ entry }: { entry: Mv3GalleryEntry }) {
  const rows = entry.source === "form" ? 4 : 3;
  return (
    <div className="mv3c-tile" style={{ height: 96 }} aria-hidden>
      <div className="mv3c-tile-rule" style={{ height: 4, width: "58%" }} />
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="mv3c-tile-rule"
          style={{
            height: 2,
            width: `${82 - i * 8}%`,
            marginTop: i === 0 ? 8 : 4,
            opacity: 0.4,
          }}
        />
      ))}
    </div>
  );
}

/**
 * A connector claim, restated as a requirement — v29 constraint 4.
 *
 * *"'Pulls from Sheets' comes off template cards. Replaced with 'needs Sheets
 * connected' — a requirement, not a claim about content."* The registry writes
 * provenance as prose for the desktop chip, and on a card that prose promises a
 * connector read that nothing in this flow performs: connector tool schemas are
 * withheld until the model calls `tool_search` mid-run, so at gallery-render
 * time Cue has read nothing. Anything that is not a pull claim is passed
 * through unchanged.
 */
function requirementLine(source: string): string {
  const pull = /^pulls?\s+from\s+((?:the|your|connected)\s+)*(.+?)\.?$/i.exec(source);
  if (!pull) return source;
  return `needs ${pull[2].trim()} connected`;
}

/** The one-line meta under a card — only says what the registry actually knows. */
function cardSub(entry: Mv3GalleryEntry): string {
  const parts: string[] = [];
  // v29: the number is what the next screen asks, and it is asked in questions.
  // A count of declared fields over-states the work and disagrees with N1.
  if (entry.questionCount > 0) {
    parts.push(
      `${entry.questionCount} question${entry.questionCount === 1 ? "" : "s"}`,
    );
  }
  // A registry provenance hint is a description of the template, not a promise
  // about this user's projects — so it is rendered only when the template
  // declares one, and only as a requirement it can stand behind. A `files` hint
  // is deliberately not rendered at all: constraint 3 moves the filing line to
  // the delivered card, where it is a receipt rather than a promise.
  if (entry.provenance && "source" in entry.provenance) {
    parts.push(requirementLine(entry.provenance.source));
  }
  return parts.join(" · ");
}

export function CreateGallery({
  typeId,
  onSwitchType,
  onPickTemplate,
  onBlank,
  onShowAll,
  showingAll = false,
}: CreateGalleryProps) {
  const type = getCreateType(typeId);
  const entries = galleryEntriesFor(typeId);
  const visible = showingAll ? entries : entries.slice(0, VISIBLE);
  const hidden = entries.length - visible.length;

  return (
    <>
      {/* No title here: the pushed stage's nav row already names the scope, and
          two "Slides" headings stacked read as a rendering bug. */}
      {/* Switch scope without going back. */}
      <div
        className="mv3c-chips"
        role="group"
        aria-label="Change what you're making"
      >
        {MV3_CREATE_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="mv3c-chip"
            aria-pressed={t.id === typeId}
            onClick={() => {
              if (t.id === typeId) return;
              haptic.light();
              onSwitchType(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mv3c-body">
        {entries.length === 0 ? (
          <div className="mv3c-empty">
            <div className="mv3c-emptytitle">No templates for {type?.label}</div>
            <div className="mv3c-emptywhy">
              This type has no template catalog yet — describe what you want
              instead and I'll build it from your words.
            </div>
            <button
              type="button"
              className="mv3c-primary"
              style={{ marginTop: 14 }}
              onClick={() => {
                haptic.light();
                onBlank();
              }}
            >
              {type?.blankLabel ?? "Describe it"}
            </button>
          </div>
        ) : (
          <div className="mv3c-grid">
            {visible.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="mv3c-card"
                aria-label={
                  cardSub(entry) ? `${entry.title} — ${cardSub(entry)}` : entry.title
                }
                onClick={() => {
                  haptic.light();
                  onPickTemplate(entry.id);
                }}
              >
                <CardPreview entry={entry} />
                <div className="mv3c-cardmeta">
                  <div className="mv3c-cardname">{entry.title}</div>
                  {cardSub(entry) ? (
                    <div className="mv3c-cardsub">{cardSub(entry)}</div>
                  ) : null}
                </div>
              </button>
            ))}

            {/* Rule 6: in the grid, not below it. */}
            <button
              type="button"
              className="mv3c-card mv3c-blank"
              aria-label={`${type?.blankLabel ?? "Blank"} — describe it`}
              onClick={() => {
                haptic.light();
                onBlank();
              }}
            >
              <span className="mv3c-blank-glyph" aria-hidden>
                ✎
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--mv3-text)",
                  marginTop: 6,
                }}
              >
                {type?.blankLabel ?? "Blank"}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 9.5,
                  color: "var(--mv3-muted)",
                  marginTop: 2,
                }}
              >
                describe it
              </span>
            </button>

            {hidden > 0 ? (
              <button
                type="button"
                className="mv3c-card mv3c-blank"
                style={{ borderStyle: "solid" }}
                aria-label={`Show ${hidden} more in ${type?.label ?? typeId}`}
                onClick={() => {
                  haptic.light();
                  onShowAll();
                }}
              >
                <span
                  className="mv3c-blank-glyph"
                  style={{ color: "var(--mv3-muted)" }}
                  aria-hidden
                >
                  ⋯
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: "var(--mv3-text)",
                    marginTop: 6,
                  }}
                >
                  {hidden} more
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 9.5,
                    color: "var(--mv3-muted)",
                    marginTop: 2,
                  }}
                >
                  in {type?.label ?? typeId}
                </span>
              </button>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
