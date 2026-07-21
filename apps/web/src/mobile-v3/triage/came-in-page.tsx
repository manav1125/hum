/**
 * CameInPage — mobile v3 "Came in today" (spec frame 15): the wedge as a
 * native triage list. Route: /assistant/came-in.
 *
 * Layout (spec-verbatim): ‹ Today · "Came in today" title · "N caught & filed
 * · swipe right to confirm, left to dismiss" · triage cards (provenance chip
 * row who·where·when, the quoted ask, DUE + → PROJECT chips) with
 * touch-driven swipe (translateX + spring-back, .light tick at the
 * threshold), the "+ N more, lower confidence" collapse, and the Confirm all /
 * "Why these?" footer.
 *
 * DATA MAPPING — the same wiring HQ's came-in strip uses:
 *   · `workitemsGet?status=pending` (typed)      → the triage queue
 *   · provenance = `sourceContext.sender` + `sourceType` + createdAt (the
 *     triage-stamped snapshot HQ's strip reads)
 *   · Confirm  → `workitemsByIdRunPost` — the work-loop's accept step
 *     (capture → triage → auto-run → review): a swipe is the same explicit
 *     consent as the "Run now" button, and the item moves out of the pending
 *     bucket into running
 *   · Dismiss  → `workitemsByIdPatch` status → "archived" (non-destructive;
 *     every list surface filters archived out; delete would be permanent)
 *   · "lower confidence" = unfiled items (no projectId) — the same split
 *     HQ's LowConfidenceFilePrompt draws.
 */
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { workitemsByIdRunPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { AuroraBackdrop, LargeTitleHeader, cardBody, mv3Mono } from "@/mobile-v3";
import { Mv3AssessmentMark } from "@/mobile-v3/assessment-mv3";
import { useDismissTask } from "@/mobile-v3/undo-toast";
import { relativeTime } from "@/domains/activity/theme";
import {
  BackRow,
  dueLabel,
  isAutoFiled,
  isBelowConfidence,
  senderOf,
} from "@/mobile-v3/work-kit";
import { holdsForYou } from "@/pages/hq/assessment-kit";
import { sourceBadge } from "@/pages/hq/hq-kit";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { Mv3RefileSheet } from "@/pages/projects/mv3-refile-sheet";
import { useProjects } from "@/pages/projects/use-projects";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

const SWIPE_THRESHOLD = 84;
const SWIPE_MAX = 120;

/** Mono pill chip (DUE FRI / → ACME RENEWAL). */
function MonoChip({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        fontFamily: mv3Mono,
        fontSize: 9,
        letterSpacing: "0.06em",
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        padding: "3px 8px",
        borderRadius: 6,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/**
 * One swipeable triage card. Pointer-driven translateX with spring-back; a
 * .light haptic ticks when the drag crosses the commit threshold, the commit
 * itself lands .medium, success .success. Buttons inside the reveal layers
 * double as tap targets for reduced-motion / assistive use.
 */
function TriageCard({
  item,
  projectTitle,
  now,
  dim,
  onConfirm,
  onDismiss,
  onRefile,
}: {
  item: HqWorkItem;
  projectTitle: string | null;
  now: number;
  dim?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  /** Opens the "Where does this belong?" sheet (✨ Move › / amber File ›). */
  onRefile?: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dx = useRef(0);
  const crossed = useRef(false);
  /** Sticky per-gesture axis lock (same real-iOS fix as SwipeArchiveRow). */
  const axis = useRef<"h" | "v" | null>(null);
  const [reveal, setReveal] = useState<0 | 1 | -1>(0);
  const [leaving, setLeaving] = useState<0 | 1 | -1>(0);

  const setX = (x: number, animate: boolean) => {
    const el = cardRef.current;
    if (!el) return;
    el.style.transition = animate
      ? "transform .28s cubic-bezier(.2,.8,.2,1)"
      : "none";
    el.style.transform = `translateX(${x}px)`;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (leaving || !e.isPrimary) return;
    start.current = { x: e.clientX, y: e.clientY };
    dx.current = 0;
    crossed.current = false;
    axis.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current || leaving || !e.isPrimary) return;
    const rawDx = e.clientX - start.current.x;
    const rawDy = e.clientY - start.current.y;
    // Lock the gesture's axis ONCE at ~8px of clear intent (the old per-move
    // |dy|>|dx| re-check let noisy diagonal samples freeze the drag, and on
    // real iOS the scroller usually claimed the touch first).
    if (axis.current == null) {
      if (Math.abs(rawDx) >= 8 && Math.abs(rawDx) > Math.abs(rawDy)) {
        axis.current = "h";
        try {
          cardRef.current?.setPointerCapture?.(e.pointerId);
        } catch {
          /* inactive pointer — drag still tracks fine */
        }
      } else if (Math.abs(rawDy) >= 8) {
        axis.current = "v"; // native scroll owns this gesture
      }
    }
    if (axis.current !== "h") return;
    const clamped = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, rawDx));
    dx.current = clamped;
    setX(clamped, false);
    setReveal(clamped > 8 ? 1 : clamped < -8 ? -1 : 0);
    const isPast = Math.abs(clamped) >= SWIPE_THRESHOLD;
    if (isPast !== crossed.current) {
      crossed.current = isPast;
      haptic.light();
    }
  };
  const commit = (dir: 1 | -1) => {
    haptic.medium();
    setLeaving(dir);
    setReveal(dir);
    setX(dir * (cardRef.current?.offsetWidth ?? 360) * 1.1, true);
    window.setTimeout(() => (dir === 1 ? onConfirm() : onDismiss()), 200);
  };
  const onPointerEnd = () => {
    if (!start.current || leaving) return;
    start.current = null;
    axis.current = null;
    if (dx.current >= SWIPE_THRESHOLD) commit(1);
    else if (dx.current <= -SWIPE_THRESHOLD) commit(-1);
    else {
      setX(0, true);
      setReveal(0);
    }
    dx.current = 0;
  };
  /** pointercancel = the OS took the touch — spring back, never commit. */
  const onPointerCancelEnd = () => {
    if (!start.current || leaving) return;
    start.current = null;
    axis.current = null;
    setX(0, true);
    setReveal(0);
    dx.current = 0;
  };

  const badge = sourceBadge(item.sourceType);
  const { sender, channel } = senderOf(item);
  // Relative "came in" age ("12m ago"), not wall-clock time — "0:06" for an
  // item that arrived at 00:06 reads as a duration (UAT P2).
  const provenance = [sender, channel, relativeTime(item.createdAt)]
    .filter(Boolean)
    .join(" · ");
  const autoFiled = projectTitle != null && isAutoFiled(item);
  // Feature-detected daemon marker; absent → the plain rendering (frame 44's
  // amber "?" grammar only when the daemon says "scored but not confident").
  const belowConfidence = isBelowConfidence(item);
  // The pre-run verdict, but only when it WAITS on a person (clarify /
  // blocked). Everything else stays quiet — no badge on every card.
  const hold = holdsForYou(item) != null;

  return (
    <div
      style={{
        position: "relative",
        borderRadius: 20,
        overflow: "hidden",
        opacity: dim && !leaving ? 0.8 : 1,
      }}
    >
      {/* Reveal layers — mounted only while the drag exposes them. */}
      {reveal === 1 ? (
        <button
          type="button"
          aria-label={`Confirm: ${item.title}`}
          onClick={() => commit(1)}
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(90deg,#277E41,#1E9E55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            paddingLeft: 20,
            border: "none",
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>
            ✓ Confirm
          </span>
        </button>
      ) : null}
      {reveal === -1 ? (
        <button
          type="button"
          aria-label={`Dismiss: ${item.title}`}
          onClick={() => commit(-1)}
          style={{
            position: "absolute",
            inset: 0,
            background: "color-mix(in srgb, var(--mv3-text) 14%, var(--mv3-bg))",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            paddingRight: 20,
            border: "none",
            cursor: "pointer",
          }}
        >
          <span
            style={{ fontSize: 15, fontWeight: 700, color: "var(--mv3-muted)" }}
          >
            Dismiss ✕
          </span>
        </button>
      ) : null}

      {/* The card itself — dragged. */}
      <div
        ref={cardRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerCancelEnd}
        style={{
          position: "relative",
          // Near-opaque (frame 15 uses .96 alpha) so the reveal layer never
          // bleeds through: the card tint painted over the solid canvas.
          background:
            "linear-gradient(var(--mv3-card), var(--mv3-card)), var(--mv3-bg)",
          border: belowConfidence
            ? "1px solid color-mix(in srgb, var(--mv3-amber) 30%, transparent)"
            : "1px solid var(--mv3-card-border)",
          borderRadius: 20,
          padding: "14px 16px",
          touchAction: "pan-y",
          // iOS: no text-selection loupe / callout mid-drag.
          WebkitUserSelect: "none",
          userSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
          cursor: "grab",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {belowConfidence ? (
            // Frame 44's amber "?" — the honest "scored, not guessed" tile.
            <span
              aria-hidden
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background:
                  "color-mix(in srgb, var(--mv3-amber) 15%, transparent)",
                color: "var(--mv3-amber)",
                fontSize: 11,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              ?
            </span>
          ) : (
            <span
              aria-hidden
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: badge.tint,
                color: "#fff",
                fontSize: 10,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {sender ? sender.charAt(0).toUpperCase() : badge.glyph}
            </span>
          )}
          <span
            style={{
              fontSize: 11.5,
              color: "var(--mv3-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            {provenance || "Captured"}
          </span>
          {belowConfidence && onRefile ? (
            <button
              type="button"
              className="cue-pressable"
              onClick={(e) => {
                e.stopPropagation();
                haptic.light();
                onRefile();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                fontSize: 11,
                color: "var(--mv3-micro)",
                background: "none",
                border: "none",
                padding: "8px 2px",
                margin: "-8px 0",
                cursor: "pointer",
                fontFamily: "inherit",
                flexShrink: 0,
              }}
            >
              File ›
            </button>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginTop: 7,
            fontStyle: sender ? "italic" : "normal",
            color: "var(--mv3-text)",
            lineHeight: 1.35,
          }}
        >
          {sender ? `“${item.title}”` : item.title}
        </div>
        {belowConfidence ? (
          <div
            style={{ fontSize: 10, color: "var(--mv3-muted)", marginTop: 2 }}
          >
            Not sure where this goes — you sort it
          </div>
        ) : null}
        {(item.dueAt != null || (projectTitle && !autoFiled) || hold) && (
          <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap", alignItems: "center" }}>
            {/* Only the two verdicts that wait on a person get a mark. */}
            {hold ? <Mv3AssessmentMark item={item} /> : null}
            {item.dueAt != null ? (
              <MonoChip
                color="var(--mv3-amber)"
                label={dueLabel(item.dueAt, now)}
              />
            ) : null}
            {projectTitle && !autoFiled ? (
              <MonoChip
                color="var(--mv3-micro)"
                label={`→ ${projectTitle.toUpperCase()}`}
              />
            ) : null}
          </div>
        )}
        {/* ✨ provenance — frame 44's inline pill: destination said out loud,
            one-tap Move (moving teaches Cue). */}
        {autoFiled ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
              padding: "7px 10px",
              background:
                "color-mix(in srgb, var(--mv3-accent) 10%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--mv3-accent) 25%, transparent)",
              borderRadius: 10,
            }}
          >
            <span aria-hidden style={{ fontSize: 11 }}>
              ✨
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--mv3-muted)",
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              auto-filed →{" "}
              <b style={{ color: "var(--mv3-text)" }}>{projectTitle}</b>
            </span>
            {onRefile ? (
              <button
                type="button"
                className="cue-pressable"
                aria-label={`Move "${item.title}" to another project`}
                onClick={(e) => {
                  e.stopPropagation();
                  haptic.light();
                  onRefile();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  fontSize: 10.5,
                  color: "var(--mv3-micro)",
                  fontWeight: 500,
                  background: "none",
                  border: "none",
                  padding: "8px 2px",
                  margin: "-8px 0",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  flexShrink: 0,
                }}
              >
                Move ›
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CameInPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);
  const [now] = useState(() => Date.now());
  const [showLow, setShowLow] = useState(false);
  // Items animated off locally while the PATCH lands (optimistic hide).
  const [gone, setGone] = useState<Set<string>>(new Set());
  // The task the "Where does this belong?" sheet is re-filing (✨ Move ›).
  const [refileId, setRefileId] = useState<string | null>(null);

  const pending = useHqWorkItems(assistantId, "pending");
  const { projects } = useProjects(assistantId);
  const projectTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.title);
    return m;
  }, [projects]);

  const queryClient = useQueryClient();
  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  // Shared dismiss flow (archive PATCH + the 5s undo pill). The swipe itself
  // already animated the card off, so dismissals commit `immediate`.
  const {
    dismiss: dismissTask,
    gone: dismissed,
    toastNode,
  } = useDismissTask(assistantId);

  const items = useMemo(
    () =>
      [...pending.items]
        .filter((i) => !gone.has(i.id) && !dismissed.has(i.id))
        .sort((a, b) => b.createdAt - a.createdAt),
    [pending.items, gone, dismissed],
  );
  // Filed = confident; unfiled = the lower-confidence collapse (same split
  // HQ's LowConfidenceFilePrompt draws).
  const filed = items.filter((i) => i.projectId != null);
  const low = items.filter((i) => i.projectId == null);
  const filedCount = filed.length;

  const hide = (id: string) =>
    setGone((prev) => new Set(prev).add(id));

  const confirm = (item: HqWorkItem) => {
    hide(item.id);
    run.mutate(
      { path: { assistant_id: assistantId, id: item.id } },
      { onSuccess: () => haptic.success() },
    );
  };
  const dismiss = (item: HqWorkItem) => {
    // The shared flow hides the card via its own `dismissed` set (and can
    // bring it back on Undo), so no local hide() here.
    dismissTask(item, { immediate: true });
  };
  const confirmAll = () => {
    haptic.medium();
    for (const item of filed) confirm(item);
  };

  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div
      data-mv3
      data-slot="mv3-came-in"
      style={{
        position: "relative",
        height: "100%",
        // `clip` (both axes — a lone overflow-x:clip computes back to hidden
        // next to overflow-y:hidden) forbids programmatic scrollLeft drift;
        // `hidden` still allowed focus/autoscroll to wedge the shell
        // sideways (P1 546px-orb fix). The aurora is paint-contained, so
        // engines without `clip` support degrade safely.
        overflow: "clip",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />

      <BackRow
        label="Today"
        onBack={() => {
          haptic.light();
          navigate(routes.hq);
        }}
      />
      <LargeTitleHeader title="Came in today" scrollRef={scrollRef} />
      <div
        style={{
          fontSize: 13,
          color: "var(--mv3-muted)",
          padding: "5px 22px 12px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        {items.length > 0
          ? `${items.length} caught${filedCount > 0 ? " & filed" : ""} · swipe right to confirm, left to dismiss`
          : pending.isLoading
            ? "Checking what arrived…"
            : "Nothing new — captured work lands here the moment it arrives."}
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "2px 16px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {filed.map((item, i) => (
            <TriageCard
              key={item.id}
              item={item}
              projectTitle={
                item.projectId
                  ? (projectTitle.get(item.projectId) ?? null)
                  : null
              }
              now={now}
              dim={i > 1}
              onConfirm={() => confirm(item)}
              onDismiss={() => dismiss(item)}
              onRefile={() => setRefileId(item.id)}
            />
          ))}

          {low.length > 0 && !showLow ? (
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                setShowLow(true);
              }}
              style={{
                textAlign: "center",
                fontSize: 12,
                color: "var(--mv3-faint)",
                padding: "10px 0",
                minHeight: 40,
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              + {low.length} more, lower confidence
            </button>
          ) : (
            low.map((item) => (
              <TriageCard
                key={item.id}
                item={item}
                projectTitle={null}
                now={now}
                dim
                onConfirm={() => confirm(item)}
                onDismiss={() => dismiss(item)}
                onRefile={() => setRefileId(item.id)}
              />
            ))
          )}

          {items.length > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                justifyContent: "center",
                paddingTop: 6,
                flexWrap: "wrap",
              }}
            >
              {filed.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="cue-pressable"
                    onClick={confirmAll}
                    style={{
                      fontSize: 11.5,
                      color: "var(--mv3-faint)",
                      background: "none",
                      border: "none",
                      padding: "10px 4px",
                      minHeight: 40,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    Confirm all
                  </button>
                  <span
                    aria-hidden
                    style={{
                      width: 3,
                      height: 3,
                      borderRadius: "50%",
                      background: "var(--mv3-faint)",
                    }}
                  />
                </>
              ) : null}
              <span style={{ fontSize: 11.5, color: "var(--mv3-faint)" }}>
                Why these? — every catch shows its source
              </span>
            </div>
          ) : null}

          {items.length === 0 && !pending.isLoading ? (
            <div style={{ ...cardBody, textAlign: "center", paddingTop: 20 }}>
              All caught up.
            </div>
          ) : null}
        </div>
      </div>
      {toastNode}

      {/* Frame 44's "Where does this belong?" — ✨ Move › / amber File ›. */}
      <Mv3RefileSheet
        assistantId={assistantId}
        item={items.find((i) => i.id === refileId) ?? null}
        projects={projects}
        onClose={() => setRefileId(null)}
      />
    </div>
  );
}
