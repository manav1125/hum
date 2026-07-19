/**
 * Shared atoms for the mv3 PROJECTS cluster (frames 3/6/15/16/17): the live
 * pulse badge, the ‹ back row, sheet material, due/clock/elapsed formatting,
 * and the sender-context reader the came-in triage cards use. All values are
 * read off docs/design/mobile-v3/cue-mobile-v3.html — no re-imagining.
 */
import type React from "react";

import type { HqWorkItem } from "@/pages/hq/use-missions";

import { mv3Mono } from "./mv3-kit";

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** "9:04" — short clock time for provenance rows / step timestamps. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "9:37:12" — the mono step-stream timestamp (frame 17). */
export function clockTimeSeconds(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * "DUE 10:30" / "DUE FRI" / "DUE JUL 31" / "OVERDUE" — the triage DUE chip
 * (frame 15). `now` is a stable reference time supplied by the caller.
 */
export function dueLabel(dueAt: number, now: number): string {
  if (dueAt < now) return "OVERDUE";
  const due = new Date(dueAt);
  const sameDay = new Date(now).toDateString() === due.toDateString();
  if (sameDay) return `DUE ${clockTime(dueAt)}`;
  if (dueAt - now < 7 * 86_400_000) {
    return `DUE ${due
      .toLocaleDateString(undefined, { weekday: "short" })
      .toUpperCase()}`;
  }
  return `DUE ${due
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toUpperCase()}`;
}

/** "JUL 31" — the ON TRACK microlabel's date leg (frame 6). */
export function shortDate(at: number): string {
  return new Date(at)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toUpperCase();
}

/** "4 min" — elapsed run time (frames 3/17). */
export function elapsedLabel(sinceMs: number, now: number): string {
  const mins = Math.max(0, Math.round((now - sinceMs) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * Sender + channel off the triage-stamped `sourceContext` snapshot — the same
 * read HQ's came-in strip performs (hq-page `senderContext`), re-derived here
 * because that helper is module-private.
 */
export function senderOf(item: HqWorkItem): {
  sender: string | null;
  channel: string | null;
} {
  let sender: string | null = null;
  try {
    const raw = item.sourceContext
      ? (JSON.parse(item.sourceContext) as { sender?: unknown })
      : null;
    if (typeof raw?.sender === "string" && raw.sender.trim())
      sender = raw.sender.trim();
  } catch {
    // Malformed snapshot — channel-only provenance.
  }
  return { sender, channel: item.sourceType ?? null };
}

/**
 * Rebuild the FULL work-item PATCH body (the daemon requires every field even
 * for a one-field change) — mirrors hq-page's `moveBody`.
 */
export function fullPatchBody(
  item: HqWorkItem,
  patch: Partial<{ projectId: string | null; status: string; context: string | null }>,
) {
  let labels: string[] = [];
  if (item.labels) {
    try {
      const parsed = JSON.parse(item.labels) as unknown;
      if (Array.isArray(parsed))
        labels = parsed.filter((l): l is string => typeof l === "string");
    } catch {
      // ignore malformed labels
    }
  }
  return {
    title: item.title,
    notes: item.notes ?? "",
    status: patch.status ?? item.status,
    priorityTier: item.priorityTier,
    sortIndex: item.sortIndex ?? 0,
    projectId:
      patch.projectId !== undefined ? patch.projectId : item.projectId,
    dueAt: item.dueAt,
    labels,
    assignee: item.assignee ?? "cue",
    context: patch.context !== undefined ? patch.context : (item.context ?? null),
  };
}

/* -------------------------------------------------------------------------- */
/* Visual atoms                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The live pulse badge — a blue rounded square carrying a 2–3 bar equalizer
 * with a pinging outline (frames 3/17 headers).
 */
export function LivePulseBadge({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden
      data-mv3
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.35),
        background: "var(--mv3-accent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: -3,
          borderRadius: Math.round(size * 0.35) + 2,
          border: "1.5px solid rgba(61,110,232,.7)",
          animation: "mv3Ping 1.8s ease-out infinite",
        }}
      />
      <span style={{ display: "flex", gap: 1.5, height: size * 0.45 }}>
        {[0, 0.3, 0.6].map((d) => (
          <span
            key={d}
            style={{
              width: 1.8,
              background: "#fff",
              borderRadius: 1,
              animation: `mv3Bar .9s ease-in-out ${d}s infinite`,
            }}
          />
        ))}
      </span>
    </span>
  );
}

/** The 2-bar mini equalizer beside a project's live agent line (frame 6). */
export function MiniBars() {
  return (
    <span
      aria-hidden
      style={{ display: "flex", gap: 1.5, height: 10, alignItems: "center" }}
    >
      {[0, 0.3].map((d) => (
        <span
          key={d}
          style={{
            width: 2,
            height: "100%",
            background: "var(--mv3-accent)",
            borderRadius: 1,
            animation: `mv3Bar .9s ease-in-out ${d}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

/** ‹ back row (frames 3/15/16/17) — 16px accent chevron link, ≥44pt target. */
export function BackRow({
  label,
  onBack,
  trailing,
}: {
  label: string;
  onBack: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      data-mv3
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "4px 20px 0",
        flexShrink: 0,
        position: "relative",
        zIndex: 2,
      }}
    >
      <button
        type="button"
        className="cue-pressable"
        onClick={onBack}
        style={{
          fontSize: 16,
          color: "var(--mv3-micro)",
          background: "none",
          border: "none",
          padding: "10px 4px",
          margin: "-10px 0",
          minHeight: 44,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        ‹ {label}
      </button>
      {trailing ? (
        <span style={{ marginLeft: "auto" }}>{trailing}</span>
      ) : null}
    </div>
  );
}

/** Mono section microlabel ("CAUGHT SO FAR — …", frame 25 / frame 3 sheet). */
export const sectionMicro: React.CSSProperties = {
  fontFamily: mv3Mono,
  fontSize: 9.5,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--mv3-faint)",
};

/**
 * The inline sheet material (frame 3): the work rides an iOS sheet pinned to
 * the bottom of the screen — same tokens as SheetShell, but laid out in-flow
 * (SheetShell itself is a modal that portals over a scrim, which frame 3's
 * always-present sheet is not).
 */
export const inlineSheet: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: "var(--mv3-sheet)",
  borderRadius: "28px 28px 0 0",
  borderTop: "1px solid var(--mv3-sheet-border)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  position: "relative",
  zIndex: 2,
  padding: "10px 18px 0",
  display: "flex",
  flexDirection: "column",
};

/** The 40×5 sheet grabber. */
export function Grabber() {
  return (
    <span
      aria-hidden
      style={{
        width: 40,
        height: 5,
        borderRadius: 99,
        background: "var(--mv3-grabber)",
        margin: "0 auto 14px",
        flexShrink: 0,
        display: "block",
      }}
    />
  );
}
