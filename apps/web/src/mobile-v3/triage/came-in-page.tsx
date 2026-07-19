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
import {
  workitemsByIdPatchMutation,
  workitemsByIdRunPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { AuroraBackdrop, LargeTitleHeader, cardBody, mv3Mono } from "@/mobile-v3";
import {
  BackRow,
  clockTime,
  dueLabel,
  fullPatchBody,
  senderOf,
} from "@/mobile-v3/work-kit";
import { sourceBadge } from "@/pages/hq/hq-kit";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
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
}: {
  item: HqWorkItem;
  projectTitle: string | null;
  now: number;
  dim?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dx = useRef(0);
  const crossed = useRef(false);
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
    if (leaving) return;
    start.current = { x: e.clientX, y: e.clientY };
    dx.current = 0;
    crossed.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current || leaving) return;
    const rawDx = e.clientX - start.current.x;
    const rawDy = e.clientY - start.current.y;
    if (Math.abs(rawDx) < 6 || Math.abs(rawDy) > Math.abs(rawDx)) return;
    // Horizontal intent — capture so vertical scroll doesn't fight the swipe.
    (e.target as Element).setPointerCapture?.(e.pointerId);
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
    if (dx.current >= SWIPE_THRESHOLD) commit(1);
    else if (dx.current <= -SWIPE_THRESHOLD) commit(-1);
    else {
      setX(0, true);
      setReveal(0);
    }
    dx.current = 0;
  };

  const badge = sourceBadge(item.sourceType);
  const { sender, channel } = senderOf(item);
  const provenance = [sender, channel, clockTime(item.createdAt)]
    .filter(Boolean)
    .join(" · ");

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
        onPointerCancel={onPointerEnd}
        style={{
          position: "relative",
          // Near-opaque (frame 15 uses .96 alpha) so the reveal layer never
          // bleeds through: the card tint painted over the solid canvas.
          background:
            "linear-gradient(var(--mv3-card), var(--mv3-card)), var(--mv3-bg)",
          border: "1px solid var(--mv3-card-border)",
          borderRadius: 20,
          padding: "14px 16px",
          touchAction: "pan-y",
          cursor: "grab",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          <span
            style={{
              fontSize: 11.5,
              color: "var(--mv3-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {provenance || "Captured"}
          </span>
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
        {(item.dueAt != null || projectTitle) && (
          <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
            {item.dueAt != null ? (
              <MonoChip
                color="var(--mv3-amber)"
                label={dueLabel(item.dueAt, now)}
              />
            ) : null}
            {projectTitle ? (
              <MonoChip
                color="var(--mv3-micro)"
                label={`→ ${projectTitle.toUpperCase()}`}
              />
            ) : null}
          </div>
        )}
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

  const pending = useHqWorkItems(assistantId, "pending");
  const { projects } = useProjects(assistantId);
  const projectTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.title);
    return m;
  }, [projects]);

  const queryClient = useQueryClient();
  const patch = useMutation({
    ...workitemsByIdPatchMutation(),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSettled: () => void queryClient.invalidateQueries(),
  });

  const items = useMemo(
    () =>
      [...pending.items]
        .filter((i) => !gone.has(i.id))
        .sort((a, b) => b.createdAt - a.createdAt),
    [pending.items, gone],
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
    hide(item.id);
    patch.mutate({
      path: { assistant_id: assistantId, id: item.id },
      body: fullPatchBody(item, { status: "archived" }),
    });
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
        overflow: "hidden",
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
    </div>
  );
}
