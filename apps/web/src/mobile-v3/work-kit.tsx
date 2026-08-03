/**
 * Shared atoms for the mv3 PROJECTS cluster (frames 3/6/15/16/17): the live
 * pulse badge, the ‹ back row, sheet material, due/clock/elapsed formatting,
 * and the sender-context reader the came-in triage cards use. All values are
 * read off docs/design/mobile-v3/cue-mobile-v3.html — no re-imagining.
 */
import type React from "react";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { WORK_VIEWS, type WorkView } from "@/components/nav/nav-model";
import { useNavCounts } from "@/components/nav/use-nav-counts";
import { workitemsByIdRunPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useNeedsYouBadge } from "@/hooks/use-needs-you-badge";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { rateLimitRetry } from "@/utils/rate-limit-retry";

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
 * Auto-file provenance marker (feature-detected: the daemon stamps
 * `autoFiledBy: "cue"` + `autoFileConfidence` when its background auto-filer
 * assigned `projectId`; older daemons carry neither and degrade to a plain
 * project chip). `autoFiledBy: "user_unfiled"` is the daemon's "the user
 * deliberately unfiled this" guard — NOT auto-filed. Checks the item record
 * itself and the triage-stamped `sourceContext` snapshot. Only meaningful
 * alongside a non-null `projectId` — gate at the call site.
 */
export function isAutoFiled(item: HqWorkItem): boolean {
  const rec = item as unknown as Record<string, unknown>;
  if (rec.autoFiledBy === "cue") return true;
  if (rec.autoFiled === true) return true;
  try {
    const ctx = item.sourceContext
      ? (JSON.parse(item.sourceContext) as unknown)
      : null;
    if (ctx && typeof ctx === "object") {
      const c = ctx as Record<string, unknown>;
      if (c.autoFiledBy === "cue") return true;
      if (c.autoFiled === true) return true;
    }
  } catch {
    // Malformed snapshot — no marker.
  }
  return false;
}

/**
 * Below-confidence arrival (frame 44/D2's amber "?" card): the daemon SCORED
 * the item but left it unfiled because confidence fell below its threshold.
 * Feature-detected — the auto-file sweep stamps `autoFileConfidence` on
 * below-threshold items while `projectId` and `autoFiledBy` stay null (that
 * exact shape is this check); an explicit `autoFileStatus:
 * "below_confidence"` is honored too. Older daemons write neither marker, so
 * this returns false and the surfaces keep the plain rendering.
 */
export function isBelowConfidence(item: HqWorkItem): boolean {
  if (item.projectId != null) return false;
  const rec = item as unknown as Record<string, unknown>;
  if (rec.autoFiledBy === "user_unfiled") return false; // deliberate unfile
  if (rec.autoFileStatus === "below_confidence") return true;
  return typeof rec.autoFileConfidence === "number";
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
/* Parked tasks + one-tap run                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parked = the daemon's trust guard: user-loaded tasks land with
 * `autoRunEligibility: "parked"` so they NEVER silently run/spend — they wait
 * for an explicit ▶. Only meaningful while the item still sits in the queue.
 * Older daemons omit the field → false (no chip, no behavior change).
 */
export function isParked(item: HqWorkItem): boolean {
  return (
    (item.status === "queued" || item.status === "pending") &&
    item.autoRunEligibility === "parked"
  );
}

/**
 * One-tap run for queue rows — the SAME endpoint as the task sheet's "Have
 * Cue handle it" (`POST work-items/:id/run`, which un-parks + runs).
 * `started` is the optimistic overlay: rows in it render as running (pulse +
 * "Cue picked this up") until the daemon's status flip lands; an error rolls
 * the row back to its parked rendering. On success the work-item buckets are
 * invalidated directly (targeted — every `workitemsGet` status variant plus
 * the activity read model) so the row transitions without waiting on the
 * 60s safety-net poll; SSE (`work_item_status_changed`) follows.
 */
export function useRunNow(assistantId: string): {
  runNow: (item: HqWorkItem) => void;
  started: Set<string>;
} {
  const queryClient = useQueryClient();
  const [started, setStarted] = useState<Set<string>>(() => new Set());
  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    ...rateLimitRetry,
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({
        predicate: (q) => {
          const first = q.queryKey[0] as { _id?: unknown } | undefined;
          return (
            first != null &&
            typeof first === "object" &&
            (first._id === "workitemsGet" ||
              first._id === "activityGet" ||
              // Project cards derive running counts / % from projectsGet
              // stats — refresh them too so the card doesn't go stale.
              String(first._id ?? "").startsWith("projects"))
          );
        },
      });
    },
    onError: (_err, vars) => {
      // Roll the optimistic running row back to parked.
      setStarted((s) => {
        const next = new Set(s);
        next.delete(vars.path.id);
        return next;
      });
    },
  });
  const runNow = (item: HqWorkItem) => {
    if (started.has(item.id)) return;
    haptic.medium();
    setStarted((s) => new Set(s).add(item.id));
    run.mutate({ path: { assistant_id: assistantId, id: item.id } });
  };
  return { runNow, started };
}

/**
 * The inline ▶ Run affordance for queue rows — 44pt hit target wrapped
 * around a 30px accent tile (negative margins keep frame 48's row density).
 * Click stops propagation so the tap runs instead of opening the row;
 * pointerdown is NOT stopped so swipe/long-press still work from here.
 */
export function RunNowButton({
  title,
  onRun,
  style,
}: {
  /** Task title, for the accessible label. */
  title: string;
  onRun: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-label={`Run now: ${title}`}
      className="cue-pressable"
      onClick={(e) => {
        e.stopPropagation();
        onRun();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        width: 44,
        height: 44,
        margin: "-7px -8px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        flexShrink: 0,
        fontFamily: "inherit",
        WebkitTapHighlightColor: "transparent",
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          borderRadius: 10,
          background:
            "color-mix(in srgb, var(--mv3-accent) 16%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--mv3-accent) 35%, transparent)",
          color: "var(--mv3-accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
        }}
      >
        ▶
      </span>
    </button>
  );
}

/** The quiet mono "○ parked" leg for a row's metadata line. */
export function ParkedMark(): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: mv3Mono,
        fontSize: 9.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--mv3-faint)",
      }}
    >
      ○ parked
    </span>
  );
}

const COACH_KEY = "mv3-parked-coach-shown";

/**
 * First-run coaching, deterministic (UAT 2026-07-21): the line shows while
 * ANY parked row is visible on a surface, capped at once per surface per
 * session. The old single global stamp made it a race — whichever surface
 * mounted first (even one the user never looked at) consumed the stamp and
 * every other surface stayed silent, so the coachline appeared to come and
 * go at random.
 */
export function ParkedCoachline({
  hasParked,
  surface = "default",
}: {
  hasParked: boolean;
  /** Per-surface session cap key ("all-work", "project-detail", …). */
  surface?: string;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!hasParked || show) return;
    const key = `${COACH_KEY}:${surface}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage unavailable — still coach this mount.
    }
    setShow(true);
  }, [hasParked, show, surface]);
  // The line rides with the parked rows: if the last parked row leaves
  // (run/dismissed), the coaching goes with it instead of dangling.
  if (!show || !hasParked) return null;
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--mv3-faint)",
        lineHeight: 1.5,
        padding: "4px 6px 0",
      }}
    >
      Parked tasks wait for you — tap ▶ and Cue gets to work.
    </div>
  );
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
        // Top inset: these screens render full-bleed with the legacy mobile
        // header hidden, so the back row owns the status-bar/island area.
        padding:
          "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 4px) 20px 0",
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

/* -------------------------------------------------------------------------- */
/* Work's header chrome (v23 C2/C3)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Work's three views as ONE segmented control — Things · Everything · Library
 * (v23 C2, and the R1 revision that put Library here).
 *
 * Library stopped being a destination and became Work's third view: desktop
 * already reads that way, and Library IS work output, so it belongs inside the
 * tab called Work rather than competing with it. Three segments is the phone's
 * ceiling — anything else (the Professional/Personal filter) goes to a sheet.
 *
 * The segments are rendered from {@link WORK_VIEWS}, the same declaration
 * desktop's switcher reads, so a view cannot exist on one platform that the
 * other has no way into or out of.
 *
 * COLOUR: the frame draws the selected segment as white on the bright blue
 * gradient. At 11.5px that is a TEXT context, so it takes the accent's
 * `-on-fill` leg — the standing rule from v23's contrast finding, and the one
 * `mv3-contrast-tokens.test.ts` enforces.
 */
export function WorkSegmented({
  current,
  onPick,
}: {
  current: WorkView;
  /** Optional interception; by default each segment navigates. */
  onPick?: (view: WorkView) => void;
}) {
  const navigate = useNavigate();
  return (
    <div
      role="tablist"
      aria-label="Work views"
      style={{
        display: "flex",
        gap: 3,
        background: "var(--mv3-token-well)",
        border: "1px solid var(--mv3-token-well-border)",
        borderRadius: 11,
        padding: 3,
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
              if (onPick) onPick(view.key);
              else navigate(view.to);
            }}
            style={{
              flex: 1,
              minHeight: 34,
              textAlign: "center",
              fontSize: 11.5,
              fontWeight: selected ? 600 : 400,
              // White on the accent's text leg — never the bright value.
              color: selected ? "#fff" : "var(--mv3-muted)",
              background: selected
                ? "var(--mv3-accent-on-fill)"
                : "transparent",
              border: "none",
              borderRadius: 9,
              padding: "7px 0",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Work's counts line — "5 things · 31 open · 3 need you" (C2).
 *
 * Every leg is a real count off the same two fetches the rail's badges read
 * ({@link useNavCounts} / {@link useNeedsYouBadge}), so the headline and the
 * badge cannot disagree — a bug this codebase has already had to fix once.
 * Legs that are zero are dropped rather than printed: "0 need you" is noise,
 * and a row of zeros is the fake precision the rules refuse.
 */
export function WorkCountsLine({
  assistantId,
  /** Replaces the whole line — the Library view says what it made instead. */
  override,
}: {
  assistantId: string | null;
  override?: string;
}) {
  const counts = useNavCounts(assistantId);
  const needsYou = useNeedsYouBadge(assistantId);
  const parts: string[] = [];
  if (!override) {
    parts.push(`${counts.things} ${counts.things === 1 ? "thing" : "things"}`);
    if (counts.everything > 0) parts.push(`${counts.everything} open`);
    if (needsYou.count > 0) parts.push(`${needsYou.count} need you`);
  }
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--mv3-muted)",
        marginTop: 3,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {override ?? parts.join(" · ")}
    </div>
  );
}

/**
 * The Work header block: title, counts line, segmented control — the three
 * rows C2 and C3 share above the scroller, so the three views cannot drift
 * apart at the top of the screen.
 */
export function WorkHeader({
  assistantId,
  current,
  countsOverride,
  trailing,
}: {
  assistantId: string | null;
  current: WorkView;
  countsOverride?: string;
  /** Right-hand affordance on the title row (filter, ＋, search). */
  trailing?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "0 18px 8px",
        flexShrink: 0,
        position: "relative",
        zIndex: 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1
            style={{
              fontSize: 23,
              fontWeight: 700,
              letterSpacing: "-0.6px",
              margin: 0,
              color: "var(--mv3-text)",
            }}
          >
            Work
          </h1>
          <WorkCountsLine
            assistantId={assistantId}
            override={countsOverride}
          />
        </div>
        {trailing ?? null}
      </div>
      <div style={{ marginTop: 10 }}>
        <WorkSegmented current={current} />
      </div>
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
