/**
 * Work's two views, and the doorway line every Work row carries.
 *
 * `Things` (containers) and `Everything` (the flat ledger) are two views of
 * ONE destination. Both surfaces used to answer to the word "work" — the tab
 * and the old "All work" ledger — which was the second collision that word
 * caused in a single week. The fix was a merge rather than another rename:
 * the grouping headers inside Everything are the same things listed in
 * Things, so the two views are provably the same data.
 *
 * The switcher is rendered by BOTH views (and by both platforms' renderings
 * of them) from `WORK_VIEWS`, so a view can never exist that you cannot get
 * back out of.
 */

import { useNavigate } from "react-router";

import { WORK_VIEWS, type WorkView } from "@/components/nav/nav-model";
import { C, mono } from "@/domains/activity/theme";
import { haptic } from "@/utils/haptics";

/** Desktop switcher — a quiet segmented control in the serif-HQ language. */
export function WorkViewTabs({ current }: { current: WorkView }) {
  const navigate = useNavigate();
  return (
    <div
      role="tablist"
      aria-label="Work views"
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 3,
        borderRadius: 10,
        background: C.sunken,
        border: `1px solid ${C.line}`,
      }}
    >
      {WORK_VIEWS.map((view) => {
        const selected = view.key === current;
        return (
          <button
            key={view.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => navigate(view.to)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: selected ? 600 : 400,
              fontFamily: "inherit",
              color: selected ? C.ink : C.t2,
              background: selected ? C.surface : "transparent",
              border: "none",
              borderRadius: 8,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            {/* A glyph, not a colour — the selected view has to survive a
                greyscale screenshot. */}
            <span aria-hidden style={{ fontFamily: mono, fontSize: 11 }}>
              {view.key === "things" ? "◱" : "≣"}
            </span>
            {view.label}
          </button>
        );
      })}
    </div>
  );
}

/** Mobile switcher — the mv3 segment pills used across the phone surfaces. */
export function Mv3WorkViewTabs({ current }: { current: WorkView }) {
  const navigate = useNavigate();
  return (
    <div
      role="tablist"
      aria-label="Work views"
      style={{
        display: "flex",
        gap: 7,
        padding: "10px 22px 4px",
        flexShrink: 0,
        position: "relative",
        zIndex: 2,
      }}
    >
      {WORK_VIEWS.map((view) => {
        const selected = view.key === current;
        return (
          <button
            key={view.key}
            type="button"
            role="tab"
            aria-selected={selected}
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              navigate(view.to);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              fontWeight: selected ? 600 : 400,
              color: selected ? "var(--mv3-bg)" : "var(--mv3-muted)",
              background: selected ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
              border: selected
                ? "1px solid transparent"
                : "1px solid var(--mv3-btn2-border)",
              borderRadius: 99,
              padding: "7px 15px",
              minHeight: 34,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span aria-hidden>{view.key === "things" ? "◱" : "≣"}</span>
            {view.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The doorway line: "1 needs you · 2 running · 9 total", plus who is on it.
 *
 * A ring and a status word alone reads as a dashboard tile — a thing you look
 * at. Counts and the people/agents working make it a door you can see a room
 * behind. This was a direct correction: the first version of the Work row
 * read as a portfolio summary and the owner called it.
 *
 * Every segment is a real count off the thing's own stats rollup. Segments
 * with nothing in them are omitted rather than rendered as zeros — "0 running"
 * is noise, and a row of zeros is the fake-precision this product refuses.
 * `total` always renders, because a thing with nothing in it is a fact worth
 * seeing.
 */
export function DoorwayLine({
  needsYou,
  running,
  total,
  workers,
  compact = false,
}: {
  needsYou: number;
  running: number;
  total: number;
  /** Distinct assignees on this thing's live items. Empty renders nothing. */
  workers: string[];
  compact?: boolean;
}) {
  const segments: { glyph: string; text: string; color: string }[] = [];
  if (needsYou > 0)
    segments.push({
      glyph: "‖",
      text: `${needsYou} needs you`,
      color: C.amber,
    });
  if (running > 0)
    segments.push({ glyph: "◱", text: `${running} running`, color: C.blueS });
  segments.push({ glyph: "≣", text: `${total} total`, color: C.t2 });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: compact ? 5 : 7,
        fontSize: compact ? 11 : 11.5,
        color: C.t2,
        marginTop: compact ? 7 : 9,
      }}
    >
      {segments.map((segment, i) => (
        <span
          key={segment.text}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            color: segment.color,
            whiteSpace: "nowrap",
          }}
        >
          {i > 0 ? (
            <span aria-hidden style={{ color: C.t3, marginRight: 3 }}>
              ·
            </span>
          ) : null}
          <span aria-hidden style={{ fontFamily: mono, fontSize: 10 }}>
            {segment.glyph}
          </span>
          {segment.text}
        </span>
      ))}
      {workers.length > 0 ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            marginLeft: 2,
            color: C.t3,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden style={{ color: C.t3 }}>
            ·
          </span>
          {workers.slice(0, 3).join(", ")}
          {workers.length > 3 ? ` +${workers.length - 3}` : ""}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Distinct assignees on a thing's live items, in a stable, readable form.
 *
 * `assignee` is `"cue" | "you" | <contact name>`, and null reads as "cue" —
 * so "who is on this" is answerable from data that already ships, without
 * inventing agent identities the daemon has never claimed.
 */
export function describeWorkers(
  assignees: (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of assignees) {
    const value = (raw ?? "cue").trim();
    if (!value) continue;
    const label =
      value.toLowerCase() === "cue"
        ? "Cue"
        : value.toLowerCase() === "you"
          ? "You"
          : value;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
