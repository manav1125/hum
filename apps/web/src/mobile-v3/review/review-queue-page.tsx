/**
 * ReviewQueuePage — mobile v3 "Review" (spec frame 16): judge the work, not
 * metadata. Route: /assistant/review-queue.
 *
 * Layout (spec-verbatim): ‹ · title · "◱ Ready for review · …" · "1 of N"
 * header, the deliverable filling the canvas, actions pinned below (Approve →
 * done / Redo…), and the quick-note chips (Make it shorter / More formal /
 * Wrong data / Lead with…) — redirect over reject.
 *
 * DATA MAPPING — the same store Today's violet cards ride:
 *   · `workitemsGet?status=awaiting_review` (typed)  → the pager queue
 *   · `workitemsByIdOutputGet`                       → summary + highlights
 *     (rendered as a rich text "document" card — no per-item file preview
 *     exists, so the canvas degrades to the result text, per plan)
 *   · Approve → `workitemsByIdCompletePost`
 *   · Redo    → `workitemsByIdRunPost`; a quick-note chip first PATCHes the
 *     item's `context` (the field the runner reads before every run) with the
 *     correction, then reruns — the existing redo path plus the existing
 *     per-task-context teach path.
 * OMITTED: the "IN YOUR BRAND ✓" microlabel — run outputs carry no brand
 * metadata today.
 */
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { useNavigate, useSearchParams } from "react-router";
import remarkGfm from "remark-gfm";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { relativeTime } from "@/domains/activity/theme";
import { goBackWithFallback } from "@/domains/chat/utils/conversation-navigation";
import {
  workitemsByIdCompletePostMutation,
  workitemsByIdOutputGetOptions,
  workitemsByIdPatchMutation,
  workitemsByIdRunPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { AuroraBackdrop, cardBody } from "@/mobile-v3";
import { fullPatchBody } from "@/mobile-v3/work-kit";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { staleLabel } from "./review-kit";

const REDO_CHIPS = [
  "Make it shorter",
  "More formal",
  "Wrong data",
  "Lead with…",
];

/** How long the actions stay non-interactive after an Approve lands (so the
 *  next card's Approve can't swallow a double-tap — UAT P1-9 pager safety). */
const POST_APPROVE_BEAT_MS = 400;

/** Narrow the opaque run `output` payload (same read the Review lane does). */
function narrowOutput(raw: unknown): {
  summary: string | null;
  highlights: string[];
} {
  if (!raw || typeof raw !== "object") return { summary: null, highlights: [] };
  const rec = raw as Record<string, unknown>;
  const summary =
    typeof rec.summary === "string" && rec.summary.trim()
      ? rec.summary
      : null;
  const highlights = Array.isArray(rec.highlights)
    ? rec.highlights.filter((h): h is string => typeof h === "string")
    : [];
  return { summary, highlights };
}

/* ------------------------------------------------------------------------- */
/* Markdown on the paper card                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The run summary arrives as markdown; render it through the app's markdown
 * renderer (react-markdown + GFM — the same stack chat/docs use) instead of
 * dumping `##`/`**` literals on the flagship review ritual (QA night P1-5).
 * The canvas is ALWAYS paper-white (frame 16), so the styling uses the card's
 * fixed ink colors rather than theme tokens. Read-only document styling.
 */
const CANVAS_INK = "#1A2230";
const CANVAS_BODY = "#3A4453";
const canvasMarkdown: Components = {
  p: ({ children }) => (
    <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.6, color: CANVAS_BODY }}>
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong style={{ color: CANVAS_INK, fontWeight: 600 }}>{children}</strong>
  ),
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "#2B53C4", textDecoration: "underline" }}
    >
      {children}
    </a>
  ),
  h1: ({ children }) => (
    <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.3px", color: CANVAS_INK, margin: "16px 0 8px" }}>
      {children}
    </div>
  ),
  h2: ({ children }) => (
    <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.2px", color: CANVAS_INK, margin: "14px 0 7px" }}>
      {children}
    </div>
  ),
  h3: ({ children }) => (
    <div style={{ fontSize: 14, fontWeight: 600, color: CANVAS_INK, margin: "12px 0 6px" }}>
      {children}
    </div>
  ),
  h4: ({ children }) => (
    <div style={{ fontSize: 13.5, fontWeight: 600, color: CANVAS_INK, margin: "10px 0 5px" }}>
      {children}
    </div>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: "0 0 10px", padding: "0 0 0 18px", fontSize: 13.5, lineHeight: 1.6, color: CANVAS_BODY }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0 0 10px", padding: "0 0 0 18px", fontSize: 13.5, lineHeight: 1.6, color: CANVAS_BODY }}>
      {children}
    </ol>
  ),
  li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      style={{ margin: "0 0 10px", padding: "0 0 0 12px", borderLeft: "3px solid #D6DAE3", color: "#5A6672" }}
    >
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr style={{ border: "none", borderTop: "1px solid #E4E7EE", margin: "14px 0" }} />
  ),
  code: ({ children }) => (
    <code
      style={{
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: "0.85em",
        background: "#EFF1F6",
        color: CANVAS_INK,
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      style={{
        margin: "0 0 10px",
        padding: 12,
        borderRadius: 8,
        background: "#EFF1F6",
        overflowX: "auto",
        fontSize: "0.85em",
      }}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "0 0 10px" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12.5, color: CANVAS_BODY }}>
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{ padding: "5px 9px", textAlign: "left", fontWeight: 600, color: CANVAS_INK, borderBottom: "1px solid #D6DAE3" }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ padding: "5px 9px", verticalAlign: "top", borderBottom: "1px solid #EFF1F6" }}>
      {children}
    </td>
  ),
};

function CanvasMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={canvasMarkdown}>
      {text}
    </ReactMarkdown>
  );
}

/**
 * The deliverable canvas — a light "document" panel (frame 16 renders the
 * artifact on a paper-white card even in dark). Shows the run's summary +
 * highlights as rich text.
 */
function DeliverableCanvas({
  assistantId,
  item,
}: {
  assistantId: string;
  item: HqWorkItem;
}) {
  const output = useQuery({
    ...workitemsByIdOutputGetOptions({
      path: { assistant_id: assistantId, id: item.id },
    }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const { summary, highlights } = narrowOutput(output.data?.output);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: "#E9EBF0",
        position: "relative",
        overflow: "hidden",
        zIndex: 2,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "18px 22px",
          background: "#fff",
          borderRadius: 10,
          boxShadow: "0 20px 50px -20px rgba(23,23,28,.4)",
          padding: "26px 24px",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          color: "#1A2230",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "linear-gradient(135deg,#3D6EE8,#7F77DD)",
          }}
        />
        <div
          style={{
            fontSize: 19,
            fontWeight: 700,
            letterSpacing: "-0.4px",
            marginTop: 18,
            lineHeight: 1.25,
          }}
        >
          {item.title}
        </div>
        {output.isLoading ? (
          <div style={{ fontSize: 13, color: "#5A6672", marginTop: 14 }}>
            Loading the result…
          </div>
        ) : (
          <>
            {summary ? (
              <div style={{ marginTop: 14 }}>
                <CanvasMarkdown text={summary} />
              </div>
            ) : null}
            {highlights.length > 0 ? (
              <div style={{ marginTop: summary ? 4 : 14 }}>
                <CanvasMarkdown
                  text={highlights.map((h) => `- ${h}`).join("\n")}
                />
              </div>
            ) : null}
            {!summary && highlights.length === 0 ? (
              <div style={{ fontSize: 13, color: "#5A6672", marginTop: 14 }}>
                {item.notes?.trim() ||
                  "Cue finished this — open the thread for the full result."}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function ReviewQueuePage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);

  const awaiting = useHqWorkItems(assistantId, "awaiting_review");
  // Newest-first (UAT P1-3): the freshest deliverable leads the pager; the
  // 17-day-stale card no longer greets the user.
  const queue = useMemo(
    () =>
      [...awaiting.items].sort((a, b) => b.updatedAt - a.updatedAt),
    [awaiting.items],
  );

  // Deep-link support (QA night P1-4): `?item=<work-item-id>` opens the pager
  // AT that item (All-work rows, the brief's Review CTA, project artifact
  // rows). Read once on mount — paging afterwards is local state.
  const [searchParams] = useSearchParams();
  // Page by id (indices shift as items approve out of the bucket).
  const [currentId, setCurrentId] = useState<string | null>(
    () => searchParams.get("item"),
  );
  const index = Math.max(
    0,
    currentId ? queue.findIndex((i) => i.id === currentId) : 0,
  );
  const item = queue[index] ?? queue[0] ?? null;
  const shownIndex = item ? queue.findIndex((i) => i.id === item.id) : 0;

  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries();

  // Pager safety: after an Approve lands, the actions go non-interactive for
  // a beat so the NEXT card's Approve is never armed under the finger that
  // just tapped. The header (with the count) stays pinned throughout.
  const [approveBeat, setApproveBeat] = useState(false);
  useEffect(() => {
    if (!approveBeat) return;
    const id = window.setTimeout(
      () => setApproveBeat(false),
      POST_APPROVE_BEAT_MS,
    );
    return () => window.clearTimeout(id);
  }, [approveBeat]);

  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    onSuccess: () => {
      haptic.success();
      invalidate();
    },
  });
  const patch = useMutation({ ...workitemsByIdPatchMutation() });
  const rerun = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSuccess: () => {
      haptic.success();
      invalidate();
    },
  });
  const busy =
    approve.isPending || rerun.isPending || patch.isPending || approveBeat;

  const advance = (from: HqWorkItem) => {
    const next =
      queue.find((i) => i.id !== from.id && queue.indexOf(i) > shownIndex) ??
      queue.find((i) => i.id !== from.id) ??
      null;
    setCurrentId(next?.id ?? null);
  };

  const doApprove = (target: HqWorkItem) => {
    haptic.medium();
    approve.mutate(
      { path: { assistant_id: assistantId, id: target.id }, body: {} },
      {
        onSuccess: () => {
          setApproveBeat(true);
          advance(target);
        },
      },
    );
  };

  /** Redo — optionally teaching the correction into the item's context first. */
  const doRedo = (target: HqWorkItem, note: string | null) => {
    haptic.medium();
    const run = () =>
      rerun.mutate(
        { path: { assistant_id: assistantId, id: target.id } },
        { onSuccess: () => advance(target) },
      );
    if (note) {
      const stamped = `${target.context ? `${target.context}\n` : ""}Correction (${new Date().toLocaleDateString()}): ${note}`;
      patch.mutate(
        {
          path: { assistant_id: assistantId, id: target.id },
          body: fullPatchBody(target, { context: stamped }),
        },
        { onSuccess: run, onError: run },
      );
    } else {
      run();
    }
  };

  // Simple horizontal swipe paging over the canvas.
  const touchX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX.current) - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) < 56 || queue.length < 2) return;
    haptic.light();
    const nextIndex =
      dx < 0
        ? Math.min(shownIndex + 1, queue.length - 1)
        : Math.max(shownIndex - 1, 0);
    setCurrentId(queue[nextIndex]?.id ?? null);
  };

  return (
    <div
      data-mv3
      data-slot="mv3-review-queue"
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

      {/* Header: ‹ · title/sub · pager count. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          // Header clears the iOS status bar — the page renders
          // edge-to-edge, so the row carries the top inset itself.
          padding:
            "calc(4px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px))) 20px 8px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <button
          type="button"
          className="cue-pressable"
          aria-label="Back"
          onClick={() => {
            haptic.light();
            // Deep-link / push entries have no in-app history — land on
            // Today instead of exiting to a blank external page.
            goBackWithFallback(navigate, routes.hq);
          }}
          style={{
            fontSize: 16,
            color: "var(--mv3-micro)",
            background: "none",
            border: "none",
            padding: "10px 6px",
            margin: "-10px 0",
            minHeight: 44,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          ‹
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item?.title ?? "Review"}
          </div>
          {item ? (
            <div style={{ fontSize: 11, color: "var(--mv3-violet)" }}>
              ◱ Ready for review
              {item.updatedAt ? ` · ${relativeTime(item.updatedAt)}` : ""}
              {staleLabel(item) ? (
                <span style={{ color: "var(--mv3-amber-text)" }}>
                  {" "}
                  · {staleLabel(item)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {queue.length > 0 ? (
          <span style={{ fontSize: 12.5, color: "var(--mv3-micro)" }}>
            {Math.min(shownIndex + 1, queue.length)} of {queue.length}
          </span>
        ) : null}
      </div>

      {item ? (
        <div
          style={{ flex: 1, minHeight: 0, display: "flex" }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <DeliverableCanvas assistantId={assistantId} item={item} />
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            zIndex: 2,
            padding: "0 32px",
          }}
        >
          <div style={{ ...cardBody, textAlign: "center", fontSize: 14 }}>
            {awaiting.isLoading
              ? "Checking for finished work…"
              : "Nothing to review — when Cue finishes a piece of work, it lands here for your sign-off."}
          </div>
        </div>
      )}

      {/* Action sheet pinned below the canvas. Non-interactive during the
          post-approve beat so the next card's Approve is never pre-armed. */}
      {item ? (
        <div
          style={{
            flexShrink: 0,
            background: "var(--mv3-sheet)",
            borderTop: "1px solid var(--mv3-sheet-border)",
            backdropFilter: "blur(28px)",
            WebkitBackdropFilter: "blur(28px)",
            position: "relative",
            zIndex: 5,
            padding: "14px 18px 10px",
            pointerEvents: approveBeat ? "none" : undefined,
            opacity: approveBeat ? 0.7 : 1,
            transition: "opacity .15s ease",
          }}
        >
          <div style={{ display: "flex", gap: 9 }}>
            <button
              type="button"
              className="cue-pressable"
              disabled={busy}
              onClick={() => doApprove(item)}
              style={{
                flex: 1,
                background: "var(--mv3-green-fill)",
                color: "var(--mv3-green-on-fill)",
                border: "none",
                borderRadius: 14,
                padding: 14,
                minHeight: 50,
                fontSize: 15,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                boxShadow:
                  "0 14px 30px -10px color-mix(in srgb, var(--mv3-green) 50%, transparent)",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {approve.isPending ? "Approving…" : "Approve → done"}
            </button>
            <button
              type="button"
              className="cue-pressable"
              disabled={busy}
              onClick={() => doRedo(item, null)}
              style={{
                background: "var(--mv3-btn2-bg)",
                color: "var(--mv3-text)",
                border: "1px solid var(--mv3-btn2-border)",
                borderRadius: 14,
                padding: "14px 18px",
                minHeight: 50,
                fontSize: 14,
                fontFamily: "inherit",
                cursor: "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {rerun.isPending ? "Redoing…" : "Redo…"}
            </button>
          </div>

          {/* Quick-note chips — a tap submits the correction + reruns.
              WRAPS rather than scrolling sideways: the set is fixed and short,
              and a horizontal strip cut the last chip mid-word at 390px, which
              reads as broken overflow rather than as an affordance. */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 7,
              marginTop: 10,
              paddingBottom: 12,
            }}
          >
            {REDO_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="cue-pressable"
                disabled={busy}
                onClick={() => doRedo(item, chip)}
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  background: "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 99,
                  padding: "6px 12px",
                  minHeight: 32,
                  whiteSpace: "nowrap",
                  fontFamily: "inherit",
                  cursor: "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
