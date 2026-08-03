/**
 * Mobile v3 Create — J1, the entry.
 *
 * Design: *"1a is always the entry — one door to learn."* Every route in the
 * spine starts on this screen, so it carries four affordances and no more:
 *
 *   - the type tiles          → the scoped gallery
 *   - a suggestion            → straight to fill, template already known
 *   - the composer            → free text, typed or spoken
 *   - "Not sure…"             → the rescue
 *
 * The two detents split the type list rather than the screen's purpose: at PEEK
 * the two leading types plus the composer are reachable, which is design's "fires
 * the common case in two taps". Tapping "more" expands to FULL, where all ten
 * live. Nothing is hidden at peek that has no route to it at peek.
 */

import { useRef, useState } from "react";

import { haptic } from "@/utils/haptics";

import type { EntryAction } from "./create-spine";
import { MV3_CREATE_TYPES, type Mv3CreateType } from "./create-types";

import "./mv3-create.css";

/** A "because you're working on" row. Only rendered from real records. */
export interface EntrySuggestion {
  /** The real template id this opens. */
  templateId: string;
  typeId: string;
  title: string;
  /** Provenance line — where the suggestion came from. Required. */
  because: string;
}

export interface CreateEntryProps {
  detent: "peek" | "full";
  onExpand: () => void;
  onAction: (action: EntryAction) => void;
  onClose: () => void;
  /**
   * Suggestions the host resolved from real data. Empty is the normal case and
   * renders nothing — there is no placeholder suggestion.
   */
  suggestions?: EntrySuggestion[];
}

/**
 * A type tile — structure, not a fake preview.
 *
 * The two lead types get visibly different treatments (a slide-shaped tile with
 * body blocks, a page-shaped tile with text rules) so they read as different
 * artefacts at a glance rather than as two instances of the same card. This is
 * schematic on purpose: a real thumbnail here would be a picture of somebody
 * else's deck.
 */
function TypeTile({ type, compact }: { type: Mv3CreateType; compact: boolean }) {
  const height = compact ? 56 : 104;
  // Docs, sheets and research are text-shaped; the rest are block-shaped.
  const textShaped = ["docs", "research", "leads"].includes(type.id);
  return (
    <div className="mv3c-tile" style={{ height, padding: compact ? 10 : 13 }} aria-hidden>
      <div className="mv3c-tile-rule" style={{ height: 4, width: "58%" }} />
      {textShaped ? (
        [88, 82, 86, 60].slice(0, compact ? 3 : 4).map((w, i) => (
          <div
            key={w}
            className="mv3c-tile-rule"
            style={{
              height: 2,
              width: `${w}%`,
              marginTop: i === 0 ? 7 : 4,
              opacity: 0.35,
            }}
          />
        ))
      ) : (
        <>
          <div
            className="mv3c-tile-rule"
            style={{ height: 2, width: "78%", marginTop: 6, opacity: 0.35 }}
          />
          <div style={{ display: "flex", gap: 4, marginTop: compact ? 8 : 14 }}>
            <div
              style={{
                flex: 1,
                height: compact ? 18 : 26,
                borderRadius: 4,
                background: "var(--mv3c-ghost)",
              }}
            />
            <div
              style={{
                flex: 1,
                height: compact ? 18 : 26,
                borderRadius: 4,
                background: "var(--mv3c-ghost)",
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The tile is decorative and the meta is two sibling divs, so the control
 * announces as "Slides 7 templates" at best and as nothing at worst. Naming it
 * explicitly makes it read as one thing.
 */
function TypeCard({
  type,
  lead,
  compact,
  onPick,
}: {
  type: Mv3CreateType;
  lead: boolean;
  compact: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="mv3c-typecard"
      data-lead={lead ? "true" : "false"}
      aria-label={`${type.label} — ${type.templateCount} templates`}
      onClick={() => {
        haptic.light();
        onPick();
      }}
    >
      <TypeTile type={type} compact={compact} />
      <div className="mv3c-typemeta" style={compact ? { padding: "8px 11px" } : undefined}>
        <div className="mv3c-typename">{type.label}</div>
        <div className="mv3c-typecount">
          {type.templateCount} template{type.templateCount === 1 ? "" : "s"}
        </div>
      </div>
    </button>
  );
}

export function CreateEntry({
  detent,
  onExpand,
  onAction,
  onClose,
  suggestions = [],
}: CreateEntryProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const lead = MV3_CREATE_TYPES.slice(0, 2);
  const rest = MV3_CREATE_TYPES.slice(2);
  const showAll = detent === "full";
  // The peek exists to fire the common case in two taps, so at 42% the type
  // names and the composer must both be readable without a scroll. The title
  // and the tiles give up the height rather than the affordances.
  const compact = detent === "peek";

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // .medium on send.
    haptic.medium();
    onAction({ kind: "free_text", text: trimmed });
    setText("");
  };

  return (
    <>
      <div className="mv3c-body">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 18px",
          }}
        >
          <span className="mv3c-eyebrow" style={{ flex: 1 }}>
            Create
          </span>
          <button
            type="button"
            aria-label="Close Create"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              color: "var(--mv3-muted)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <h2
          className="mv3c-title"
          style={{ padding: "0 18px", fontSize: compact ? 21 : 29, marginTop: compact ? 4 : 8 }}
        >
          What are we
          <br />
          making today?
        </h2>

        <div style={{ paddingTop: compact ? 10 : 18 }}>
          <div className="mv3c-typerow">
            {lead.map((type) => (
              <TypeCard
                key={type.id}
                type={type}
                lead={type.id === lead[0].id}
                compact={compact}
                onPick={() => onAction({ kind: "pick_type", typeId: type.id })}
              />
            ))}
          </div>

          {showAll ? (
            // At the full detent every remaining type gets its own row — this is
            // the "all ten types" the second detent exists for.
            <div style={{ padding: "11px 18px 0", display: "grid", gap: 7 }}>
              {rest.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  className="mv3c-more"
                  onClick={() => {
                    haptic.light();
                    onAction({ kind: "pick_type", typeId: type.id });
                  }}
                >
                  <span style={{ fontSize: 15 }} aria-hidden>
                    {type.glyph}
                  </span>
                  <span style={{ flex: 1, color: "var(--mv3-text)" }}>
                    {type.label}
                  </span>
                  <span style={{ color: "var(--mv3-muted)", fontSize: 11 }}>
                    {type.templateCount}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ padding: "11px 18px 0" }}>
              <button
                type="button"
                className="mv3c-more"
                onClick={() => {
                  haptic.light();
                  onExpand();
                }}
              >
                <span style={{ display: "flex", gap: 4 }} aria-hidden>
                  {rest.slice(0, 4).map((t) => (
                    <span key={t.id} style={{ fontSize: 12 }}>
                      {t.glyph}
                    </span>
                  ))}
                </span>
                <span style={{ flex: 1 }}>
                  {rest
                    .slice(0, 4)
                    .map((t) => t.label)
                    .join(", ")}
                  {rest.length > 4 ? (
                    <span style={{ color: "var(--mv3-muted)" }}>
                      {" "}
                      +{rest.length - 4}
                    </span>
                  ) : null}
                </span>
                <span style={{ color: "var(--mv3-micro)" }}>›</span>
              </button>
            </div>
          )}

          {suggestions.length > 0 ? (
            <div style={{ padding: "18px 18px 0" }}>
              <div
                className="mv3c-eyebrow"
                style={{ color: "var(--mv3-muted)", fontSize: 8.5 }}
              >
                Because you're working on
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                  marginTop: 9,
                }}
              >
                {suggestions.map((s) => (
                  <button
                    key={s.templateId}
                    type="button"
                    className="mv3c-more"
                    onClick={() => {
                      haptic.light();
                      onAction({
                        kind: "pick_suggestion",
                        typeId: s.typeId,
                        templateId: s.templateId,
                      });
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--mv3-text)",
                        }}
                      >
                        {s.title}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 10.5,
                          color: "var(--mv3-micro)",
                          marginTop: 2,
                        }}
                      >
                        {s.because}
                      </span>
                    </span>
                    <span style={{ color: "var(--mv3-muted)" }}>›</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ height: 18 }} />
        </div>
      </div>

      {/* Composer + rescue sit in the footer: both are primary, both must stay
          in the thumb arc regardless of how tall the sheet is. */}
      <div className="mv3c-footer" style={{ borderTop: "none" }}>
        <div className="mv3c-composer">
          <label htmlFor="mv3c-describe" className="mv3c-visually-hidden" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            Describe what you want to make
          </label>
          <textarea
            id="mv3c-describe"
            ref={inputRef}
            className="mv3c-input"
            rows={1}
            placeholder="…or just describe it"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid var(--mv3-line)",
            }}
          >
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="mv3c-send"
              aria-label="Describe it"
              disabled={!text.trim()}
              onClick={submit}
            >
              ↑
            </button>
          </div>
        </div>

        <button
          type="button"
          className="mv3c-rescue"
          onClick={() => {
            haptic.light();
            onAction({ kind: "not_sure" });
          }}
        >
          Not sure what you need? <span>Talk it through ›</span>
        </button>
      </div>
    </>
  );
}
