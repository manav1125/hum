/**
 * ReviewIndexPage — round-4 frame 55: the review-queue list view.
 * Route: /assistant/review-queue/list (Today's "See all N ›" entry).
 *
 * Layout (spec-verbatim, docs/design/mobile-round4 #f55): ‹ Today back row →
 * "Review ready" 30/700 → "N waiting · newest first" + the quiet violet
 * "Archive N stale" pill → compact ◱ rows (title / project · age · agent),
 * newest first → the mono "OLDER — LIKELY STALE" divider → stale rows at 65%
 * opacity with the amber "From Jul 4 — likely stale" line → the tap/swipe
 * hint line.
 *
 * Behavior:
 *   · row tap        → the existing pager SEEDED at that item (?item=id)
 *   · "Play all ›"   → the pager from the top (kept from the old direct link)
 *   · swipe left     → archive, frame-48 grammar (SwipeArchiveRow), with the
 *                      shared single-item undo pill
 *   · "Archive N stale" → CONFIRM SHEET (v3 SheetShell — the design didn't
 *     draw it): "Archive N stale reviews? They move to the archive — nothing
 *     is deleted." + Archive / Cancel, then a batch archive with an undo
 *     toast restoring every one. Archive never delete (same full-record
 *     PATCH the ✕ flows use).
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { relativeTime } from "@/domains/activity/theme";
import { goBackWithFallback } from "@/domains/chat/utils/conversation-navigation";
import { workitemsByIdPatchMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { holdsForYou } from "@/pages/hq/assessment-kit";
import { useAgentFor } from "@/pages/hq/hq-agent-identity";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { useProjects } from "@/pages/projects/use-projects";
import { haptic } from "@/utils/haptics";
import { rateLimitRetry } from "@/utils/rate-limit-retry";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { Mv3AssessmentMark } from "../assessment-mv3";
import { cardBody, mv3Mono } from "../mv3-kit";
import { SheetShell } from "../sheet-shell";
import { SwipeArchiveRow } from "../swipe-archive-row";
import { UndoToast, useDismissTask, type Mv3Toast } from "../undo-toast";
import { fullPatchBody, BackRow } from "../work-kit";
import { hasFreshBorder, partitionReview, staleLabel } from "./review-kit";

/** One compact ◱ row (frame 55): glyph tile · title + sub-line · ›. */
function ReviewRow({
  item,
  stale,
  fresh,
  projectTitle,
  onOpen,
  onArchive,
}: {
  item: HqWorkItem;
  stale: boolean;
  /** <24h old — keeps the violet ◱ border (frame 55's top rows). */
  fresh: boolean;
  projectTitle: string | null;
  onOpen: () => void;
  onArchive: () => void;
}) {
  const agent = useAgentFor(item.assignee);
  const hold = holdsForYou(item) != null;
  const sub = stale
    ? staleLabel(item)
    : [projectTitle, relativeTime(item.updatedAt), agent?.name]
        .filter(Boolean)
        .join(" · ");
  return (
    <SwipeArchiveRow
      title={item.title}
      onOpen={onOpen}
      onArchive={onArchive}
      onLongPress={onOpen}
      containerStyle={stale ? { opacity: 0.65 } : undefined}
      rowStyle={{
        background: stale
          ? "color-mix(in srgb, var(--mv3-card) 62%, transparent)"
          : "var(--mv3-card)",
        border: stale
          ? "1px solid var(--mv3-line)"
          : fresh
            ? "1px solid color-mix(in srgb, var(--mv3-violet) 30%, transparent)"
            : "1px solid var(--mv3-card-border)",
        padding: stale ? "11px 14px" : "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 11,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          background: stale
            ? "color-mix(in srgb, var(--mv3-faint) 10%, transparent)"
            : "color-mix(in srgb, var(--mv3-violet) 16%, transparent)",
          color: stale ? "var(--mv3-faint)" : "var(--mv3-violet)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          flexShrink: 0,
        }}
      >
        ◱
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: stale ? 13 : 13.5,
            fontWeight: stale ? 400 : 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 10.5,
            color: stale ? "var(--mv3-amber)" : "var(--mv3-muted)",
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {/* Marked only when the pre-run verdict WAITS on a person; the rest
              of the sub-line ellipsises behind it, never the badge. */}
          {hold ? (
            <>
              <Mv3AssessmentMark item={item} />
              {sub ? " · " : ""}
            </>
          ) : null}
          {sub}
        </span>
      </span>
      <span aria-hidden style={{ color: "var(--mv3-faint)", flexShrink: 0 }}>
        ›
      </span>
    </SwipeArchiveRow>
  );
}

export function ReviewIndexPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);

  const awaiting = useHqWorkItems(assistantId, "awaiting_review");
  const { projects } = useProjects(assistantId);
  const projectTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.title);
    return map;
  }, [projects]);

  // Per-row swipe archive — the shared ✕ engine (undo pill included).
  const { dismiss, gone, toastNode } = useDismissTask(assistantId);

  // Batch "Archive N stale" — same full-record PATCH, N times, one undo.
  const queryClient = useQueryClient();
  const patch = useMutation({
    ...workitemsByIdPatchMutation(),
    ...rateLimitRetry,
  });
  const [batchGone, setBatchGone] = useState<Set<string>>(() => new Set());
  const [batchToast, setBatchToast] = useState<Mv3Toast | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const visible = useMemo(
    () =>
      awaiting.items.filter((i) => !gone.has(i.id) && !batchGone.has(i.id)),
    [awaiting.items, gone, batchGone],
  );
  const { fresh, stale } = useMemo(() => partitionReview(visible), [visible]);
  const total = fresh.length + stale.length;

  const openPager = (item?: HqWorkItem) => {
    haptic.light();
    navigate(
      item
        ? `${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`
        : routes.reviewQueue,
    );
  };

  const archiveStale = async () => {
    const targets = stale;
    if (targets.length === 0 || batchBusy) return;
    setBatchBusy(true);
    haptic.medium();
    const done: HqWorkItem[] = [];
    try {
      for (const item of targets) {
        await patch.mutateAsync({
          path: { assistant_id: assistantId, id: item.id },
          body: fullPatchBody(item, { status: "archived" }),
        });
        done.push(item);
        setBatchGone((prev) => new Set(prev).add(item.id));
      }
    } catch {
      // Partial failure: what archived stays archived (and undoable); the
      // rest stays in the list. Say so quietly.
      setBatchToast({
        key: Date.now(),
        tone: "error",
        message: `Archived ${done.length} of ${targets.length} — try the rest again.`,
      });
    }
    setBatchBusy(false);
    setConfirmOpen(false);
    if (done.length === targets.length && done.length > 0) {
      const undo = () => {
        haptic.light();
        for (const item of done) {
          patch.mutate(
            {
              path: { assistant_id: assistantId, id: item.id },
              body: fullPatchBody(item, { status: item.status }),
            },
            {
              onSuccess: () => {
                setBatchGone((prev) => {
                  const next = new Set(prev);
                  next.delete(item.id);
                  return next;
                });
                void queryClient.invalidateQueries();
              },
            },
          );
        }
      };
      setBatchToast({
        key: Date.now(),
        message: `Archived ${done.length} stale review${done.length === 1 ? "" : "s"}`,
        actionLabel: "Undo",
        onAction: undo,
      });
      void queryClient.invalidateQueries();
    }
  };

  return (
    <div
      data-mv3
      data-slot="mv3-review-index"
      style={{
        position: "relative",
        height: "100%",
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
          goBackWithFallback(navigate, routes.hq);
        }}
        trailing={
          total > 0 ? (
            <button
              type="button"
              className="cue-pressable"
              aria-label="Play all reviews in the pager"
              onClick={() => openPager()}
              style={{
                fontSize: 12,
                color: "var(--mv3-micro)",
                background: "none",
                border: "none",
                padding: "12px 0 12px 12px",
                margin: "-12px 0",
                minHeight: 44,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Play all ›
            </button>
          ) : null
        }
      />

      {/* Title block (frame 55: 30/700/−0.8 + meta row). */}
      <div
        style={{
          padding: "4px 22px 12px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.8px" }}>
          Review ready
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 6,
          }}
        >
          <span style={{ fontSize: 13, color: "var(--mv3-muted)" }}>
            {total} waiting · newest first
          </span>
          {stale.length > 0 ? (
            // Drawn 26px, hit target ≥44pt (padding + negative margins).
            <button
              type="button"
              className="cue-pressable"
              aria-label={`Archive ${stale.length} stale reviews`}
              onClick={() => {
                haptic.light();
                setConfirmOpen(true);
              }}
              style={{
                marginLeft: "auto",
                background: "none",
                border: "none",
                padding: "9px 0 9px 9px",
                margin: "-9px 0",
                minHeight: 44,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  fontSize: 12,
                  color: "var(--mv3-violet-text)",
                  background:
                    "color-mix(in srgb, var(--mv3-violet) 12%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--mv3-violet) 30%, transparent)",
                  borderRadius: 99,
                  padding: "5px 12px",
                }}
              >
                Archive {stale.length} stale
              </span>
            </button>
          ) : null}
        </div>
      </div>

      {/* The list. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "0 16px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
        {awaiting.isLoading && total === 0 ? (
          <div style={{ ...cardBody, textAlign: "center", padding: "40px 20px" }}>
            Checking for finished work…
          </div>
        ) : total === 0 ? (
          <div style={{ ...cardBody, textAlign: "center", padding: "40px 20px", fontSize: 14 }}>
            Nothing to review — when Cue finishes a piece of work, it lands
            here for your sign-off.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {fresh.map((item) => (
              <ReviewRow
                key={item.id}
                item={item}
                stale={false}
                fresh={hasFreshBorder(item)}
                projectTitle={
                  item.projectId
                    ? (projectTitles.get(item.projectId) ?? null)
                    : null
                }
                onOpen={() => openPager(item)}
                onArchive={() => dismiss(item, { immediate: true })}
              />
            ))}

            {stale.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 4px 2px",
                }}
              >
                <span
                  style={{
                    fontFamily: mv3Mono,
                    fontSize: 9.5,
                    letterSpacing: "0.1em",
                    color: "var(--mv3-faint)",
                  }}
                >
                  OLDER — LIKELY STALE
                </span>
                <span
                  aria-hidden
                  style={{ flex: 1, height: 1, background: "var(--mv3-line)" }}
                />
              </div>
            ) : null}

            {stale.map((item) => (
              <ReviewRow
                key={item.id}
                item={item}
                stale
                fresh={false}
                projectTitle={
                  item.projectId
                    ? (projectTitles.get(item.projectId) ?? null)
                    : null
                }
                onOpen={() => openPager(item)}
                onArchive={() => dismiss(item, { immediate: true })}
              />
            ))}

            <div
              style={{
                fontSize: 11,
                color: "var(--mv3-faint)",
                textAlign: "center",
                padding: "6px 0",
              }}
            >
              Tap any row → opens the reviewer at that item · swipe left to
              archive
            </div>
          </div>
        )}
      </div>

      {/* Confirm sheet — the design didn't draw it; v3 SheetShell grammar. */}
      <SheetShell
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        label="Archive stale reviews"
      >
        <div style={{ padding: "2px 4px 6px" }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.3px" }}>
            Archive {stale.length} stale review{stale.length === 1 ? "" : "s"}?
          </div>
          <div style={{ ...cardBody, marginTop: 6 }}>
            They move to the archive — nothing is deleted.
          </div>
          <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
            <button
              type="button"
              className="cue-pressable"
              disabled={batchBusy}
              onClick={() => void archiveStale()}
              style={{
                flex: 1,
                background: "var(--mv3-violet-on-fill)",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: 13,
                minHeight: 48,
                fontSize: 14.5,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                opacity: batchBusy ? 0.6 : 1,
              }}
            >
              {batchBusy
                ? "Archiving…"
                : `Archive ${stale.length}`}
            </button>
            <button
              type="button"
              className="cue-pressable"
              disabled={batchBusy}
              onClick={() => setConfirmOpen(false)}
              style={{
                background: "var(--mv3-btn2-bg)",
                color: "var(--mv3-text)",
                border: "1px solid var(--mv3-btn2-border)",
                borderRadius: 14,
                padding: "13px 20px",
                minHeight: 48,
                fontSize: 14,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </SheetShell>

      {toastNode}
      <UndoToast toast={batchToast} onClear={() => setBatchToast(null)} />
    </div>
  );
}
