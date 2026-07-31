/**
 * DesktopReviewPage — the desktop half of "judge the finished work".
 *
 * Until now `/assistant/review-queue` mounted the phone's full-bleed pager on
 * every device, so a desktop user mid-chat who clicked "See the result" was
 * dropped into a 390px aurora surface inside desktop chrome. This is the
 * desktop counterpart, in the serif-HQ language (`C` tokens + serif/mono from
 * `@/lib/hq-theme`, same as `pages/hq/*`): a queue on the left, the deliverable
 * and its verdict controls on the right — the shape a mouse and a wide window
 * actually want.
 *
 * DATA — the same daemon reads the phone uses, no new endpoints:
 *   · `workitemsGet?status=awaiting_review` (via `useHqWorkItems`) → the queue
 *   · `workitemsByIdOutputGet`   → the deliverable (summary + highlights)
 *   · Approve  → `workitemsByIdCompletePost`
 *   · Redo     → `workitemsByIdRunPost`; a correction chip first PATCHes the
 *     item's `context` (what the runner reads before every run), then reruns
 *   · Archive  → the full-record PATCH to `status: "archived"` (the same
 *     archive-never-delete grammar the phone's swipe uses), single or batched
 *     over the stale group, each with a real Undo
 *   · Stale grouping → `mobile-v3/review/review-kit`, so both devices agree on
 *     what "likely stale" means rather than drifting apart
 *
 * Honesty: every control here is wired to one of those calls. "Open the
 * conversation" renders only when the item actually carries a run
 * conversation; nothing claims a state the payload can't back, and the
 * deliverable panel says plainly when the run left no written result.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { StateBadge } from "@vellumai/design-library";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { useNavigate, useSearchParams } from "react-router";
import remarkGfm from "remark-gfm";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  workitemsByIdCompletePostMutation,
  workitemsByIdOutputGetOptions,
  workitemsByIdPatchMutation,
  workitemsByIdRunPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { C, mono, serif } from "@/lib/hq-theme";
import {
  hasFreshBorder,
  partitionReview,
  staleLabel,
} from "@/mobile-v3/review/review-kit";
import { fullPatchBody } from "@/mobile-v3/work-kit";
import { AssessmentSignal } from "@/pages/hq/assessment-kit";
import { useAgentFor } from "@/pages/hq/hq-agent-identity";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { rateLimitRetry } from "@/utils/rate-limit-retry";
import { routes } from "@/utils/routes";

/** Corrections that teach the item before it reruns (same set as the phone). */
const REDO_CHIPS = [
  "Make it shorter",
  "More formal",
  "Wrong data",
  "Lead with…",
];

/**
 * "3m ago" for a daemon timestamp. Deliberately a local copy of
 * `domains/activity/theme`'s helper: the cross-domain lint rule forbids
 * `review → activity`, and lifting it to a top-level dir means editing
 * activity, which is out of this change's scope. Lift both onto one shared
 * formatter when activity is next touched.
 */
function relativeTime(epoch: number | null | undefined): string | null {
  if (epoch == null || !Number.isFinite(epoch)) return null;
  // Daemon timestamps are inconsistent (some seconds, some ms). Normalise:
  // anything below ~10^12 is treated as seconds.
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

const panel: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
};

const microLabel: CSSProperties = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.t3,
};

const primaryBtn: CSSProperties = {
  border: "none",
  borderRadius: 9,
  padding: "9px 18px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  color: "#fff",
};

const quietBtn: CSSProperties = {
  background: C.sunken,
  color: C.t1,
  border: `1px solid ${C.line}`,
  borderRadius: 9,
  padding: "9px 16px",
  fontSize: 13,
  cursor: "pointer",
};

const chipBtn: CSSProperties = {
  background: "transparent",
  color: C.t2,
  border: `1px solid ${C.line}`,
  borderRadius: 99,
  padding: "5px 12px",
  fontSize: 11.5,
  cursor: "pointer",
};

/* -------------------------------------------------------------------------- */
/* Deliverable                                                                */
/* -------------------------------------------------------------------------- */

/** Narrow the opaque run `output` payload (the same read the phone does). */
function narrowOutput(raw: unknown): {
  summary: string | null;
  highlights: string[];
} {
  if (!raw || typeof raw !== "object") return { summary: null, highlights: [] };
  const rec = raw as Record<string, unknown>;
  const summary =
    typeof rec.summary === "string" && rec.summary.trim() ? rec.summary : null;
  const highlights = Array.isArray(rec.highlights)
    ? rec.highlights.filter((h): h is string => typeof h === "string")
    : [];
  return { summary, highlights };
}

/**
 * The run summary arrives as markdown. Rendered through the app's markdown
 * stack (react-markdown + GFM) in serif-HQ ink so the flagship review ritual
 * never shows raw `##`/`**`.
 */
const reviewMarkdown: Components = {
  p: ({ children }) => (
    <p
      style={{
        margin: "0 0 11px",
        fontSize: 14,
        lineHeight: 1.65,
        color: C.t2,
      }}
    >
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong style={{ color: C.t1, fontWeight: 600 }}>{children}</strong>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: C.blueText, textDecoration: "underline" }}
    >
      {children}
    </a>
  ),
  h1: ({ children }) => (
    <div
      style={{
        fontFamily: serif,
        fontSize: 22,
        color: C.t1,
        margin: "18px 0 8px",
      }}
    >
      {children}
    </div>
  ),
  h2: ({ children }) => (
    <div
      style={{
        fontFamily: serif,
        fontSize: 19,
        color: C.t1,
        margin: "16px 0 7px",
      }}
    >
      {children}
    </div>
  ),
  h3: ({ children }) => (
    <div
      style={{ fontSize: 14, fontWeight: 600, color: C.t1, margin: "14px 0 6px" }}
    >
      {children}
    </div>
  ),
  ul: ({ children }) => (
    <ul
      style={{
        margin: "0 0 11px",
        padding: "0 0 0 18px",
        fontSize: 14,
        lineHeight: 1.65,
        color: C.t2,
      }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol
      style={{
        margin: "0 0 11px",
        padding: "0 0 0 18px",
        fontSize: 14,
        lineHeight: 1.65,
        color: C.t2,
      }}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0 0 11px",
        padding: "0 0 0 12px",
        borderLeft: `3px solid ${C.line}`,
        color: C.t3,
      }}
    >
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr style={{ border: "none", borderTop: `1px solid ${C.line}`, margin: "16px 0" }} />
  ),
  code: ({ children }) => (
    <code
      style={{
        fontFamily: mono,
        fontSize: "0.85em",
        background: C.sunken,
        color: C.t1,
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
        margin: "0 0 11px",
        padding: 13,
        borderRadius: 9,
        background: C.sunken,
        overflowX: "auto",
        fontSize: "0.85em",
      }}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "0 0 11px" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 13, color: C.t2 }}>
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        padding: "6px 10px",
        textAlign: "left",
        fontWeight: 600,
        color: C.t1,
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{
        padding: "6px 10px",
        verticalAlign: "top",
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      {children}
    </td>
  ),
};

function Deliverable({
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

  if (output.isLoading) {
    return (
      <div style={{ fontSize: 13.5, color: C.t3 }}>Loading the result…</div>
    );
  }

  if (!summary && highlights.length === 0) {
    return (
      <div style={{ fontSize: 13.5, color: C.t2, lineHeight: 1.6 }}>
        {item.notes?.trim() ||
          (item.lastRunConversationId
            ? "This run left no written summary — open the conversation to read what it actually did."
            : "This run left no written summary, and it has no conversation to open. Redo it if you need the result in writing.")}
      </div>
    );
  }

  return (
    <div>
      {summary ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={reviewMarkdown}>
          {summary}
        </ReactMarkdown>
      ) : null}
      {highlights.length > 0 ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={reviewMarkdown}>
          {highlights.map((h) => `- ${h}`).join("\n")}
        </ReactMarkdown>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Queue rows                                                                 */
/* -------------------------------------------------------------------------- */

function QueueRow({
  item,
  stale,
  selected,
  onSelect,
  onArchive,
  busy,
}: {
  item: HqWorkItem;
  stale: boolean;
  selected: boolean;
  onSelect: () => void;
  onArchive: () => void;
  busy: boolean;
}) {
  const agent = useAgentFor(item.assignee);
  const accent = C.violet;
  const sub = stale
    ? staleLabel(item)
    : [relativeTime(item.updatedAt), agent?.name].filter(Boolean).join(" · ");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderRadius: 10,
        padding: "2px 4px 2px 0",
        background: selected ? "var(--mv1-blue-wash)" : "transparent",
        opacity: stale ? 0.72 : 1,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          textAlign: "left",
          background: "transparent",
          border: "none",
          borderLeft: `2px solid ${
            selected ? C.blue : hasFreshBorder(item) && !stale ? accent : "transparent"
          }`,
          padding: "9px 8px 9px 10px",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: stale ? C.t3 : accent,
            background: stale
              ? "transparent"
              : "color-mix(in srgb, var(--mv1-violet) 14%, transparent)",
            border: stale ? `1px solid ${C.line}` : "none",
          }}
        >
          ◱
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 13.5,
              fontWeight: stale ? 400 : 600,
              color: C.t1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.title}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 3,
              fontSize: 11,
              color: stale ? C.amber : C.t3,
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            <AssessmentSignal item={item} />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {sub}
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onArchive}
        title="Archive — moves it out of the queue, nothing is deleted"
        aria-label={`Archive ${item.title}`}
        style={{
          background: "transparent",
          border: "none",
          color: C.t3,
          fontSize: 13,
          padding: "6px 8px",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.5 : 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

interface UndoState {
  label: string;
  /** Restores exactly what was archived. */
  undo: () => void;
}

export function DesktopReviewPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);

  const awaiting = useHqWorkItems(assistantId, "awaiting_review");
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries();

  // Rows removed locally the moment their archive PATCH lands, so the queue
  // doesn't wait on a refetch to stop showing work you just cleared.
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const visible = useMemo(
    () => awaiting.items.filter((i) => !gone.has(i.id)),
    [awaiting.items, gone],
  );
  const { fresh, stale } = useMemo(() => partitionReview(visible), [visible]);
  const queue = useMemo(() => [...fresh, ...stale], [fresh, stale]);

  // Deep link: `?item=<id>` opens the queue AT that item (chat's "See the
  // result", the HQ Review lane, project rows). Selection writes the param
  // back so the URL always names what you're reading.
  const [searchParams, setSearchParams] = useSearchParams();
  const paramId = searchParams.get("item");
  const selected =
    queue.find((i) => i.id === paramId) ?? queue[0] ?? null;

  const select = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("item", id);
    setSearchParams(next, { replace: true });
  };

  // Keep the URL honest when the selected item leaves the queue (approved,
  // archived) — otherwise `?item=` names a row that is no longer here.
  useEffect(() => {
    if (!paramId) return;
    if (queue.some((i) => i.id === paramId)) return;
    const next = new URLSearchParams(searchParams);
    if (selected) next.set("item", selected.id);
    else next.delete("item");
    setSearchParams(next, { replace: true });
  }, [paramId, queue, selected, searchParams, setSearchParams]);

  const [undo, setUndo] = useState<UndoState | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const patch = useMutation({
    ...workitemsByIdPatchMutation(),
    ...rateLimitRetry,
  });
  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    ...rateLimitRetry,
  });
  const rerun = useMutation({
    ...workitemsByIdRunPostMutation(),
    ...rateLimitRetry,
  });
  const busy =
    approve.isPending || rerun.isPending || patch.isPending || batchBusy;

  /** Advance to the row after `from` so the queue keeps moving. */
  const advancePast = (from: HqWorkItem) => {
    const at = queue.findIndex((i) => i.id === from.id);
    const next = queue[at + 1] ?? queue[at - 1] ?? null;
    if (next) select(next.id);
  };

  const doApprove = (target: HqWorkItem) => {
    setActionError(null);
    approve.mutate(
      { path: { assistant_id: assistantId, id: target.id }, body: {} },
      {
        onSuccess: () => {
          advancePast(target);
          invalidate();
        },
        onError: () =>
          setActionError("Couldn't approve that — try again in a moment."),
      },
    );
  };

  /** Redo — optionally teaching the correction into the item's context first. */
  const doRedo = (target: HqWorkItem, note: string | null) => {
    setActionError(null);
    const run = () =>
      rerun.mutate(
        { path: { assistant_id: assistantId, id: target.id } },
        {
          onSuccess: () => {
            advancePast(target);
            invalidate();
          },
          onError: () =>
            setActionError("Couldn't start the rerun — try again in a moment."),
        },
      );
    if (!note) {
      run();
      return;
    }
    const stamped = `${target.context ? `${target.context}\n` : ""}Correction (${new Date().toLocaleDateString()}): ${note}`;
    patch.mutate(
      {
        path: { assistant_id: assistantId, id: target.id },
        body: fullPatchBody(target, { context: stamped }),
      },
      // The rerun goes ahead either way — a lost correction is worth saying
      // out loud, but it must not silently swallow the redo you asked for.
      {
        onSuccess: run,
        onError: () => {
          setActionError(
            "Saved the redo but not the correction — the rerun went ahead without it.",
          );
          run();
        },
      },
    );
  };

  const restore = (items: HqWorkItem[]) => {
    for (const item of items) {
      patch.mutate(
        {
          path: { assistant_id: assistantId, id: item.id },
          body: fullPatchBody(item, { status: item.status }),
        },
        {
          onSuccess: () => {
            setGone((prev) => {
              const next = new Set(prev);
              next.delete(item.id);
              return next;
            });
            invalidate();
          },
        },
      );
    }
    setUndo(null);
  };

  const doArchive = (target: HqWorkItem) => {
    setActionError(null);
    patch.mutate(
      {
        path: { assistant_id: assistantId, id: target.id },
        body: fullPatchBody(target, { status: "archived" }),
      },
      {
        onSuccess: () => {
          advancePast(target);
          setGone((prev) => new Set(prev).add(target.id));
          setUndo({
            label: `Archived “${target.title}”`,
            undo: () => restore([target]),
          });
          invalidate();
        },
        onError: () =>
          setActionError("Couldn't archive that — try again in a moment."),
      },
    );
  };

  const archiveStale = async () => {
    if (stale.length === 0 || batchBusy) return;
    setBatchBusy(true);
    setActionError(null);
    const targets = [...stale];
    const done: HqWorkItem[] = [];
    try {
      for (const item of targets) {
        await patch.mutateAsync({
          path: { assistant_id: assistantId, id: item.id },
          body: fullPatchBody(item, { status: "archived" }),
        });
        done.push(item);
        setGone((prev) => new Set(prev).add(item.id));
      }
    } catch {
      // Partial failure: what archived stays archived (and undoable); the rest
      // stays in the queue. Say exactly that.
      setActionError(
        `Archived ${done.length} of ${targets.length} — try the rest again.`,
      );
    }
    setBatchBusy(false);
    setConfirmBatch(false);
    if (done.length > 0) {
      setUndo({
        label: `Archived ${done.length} stale review${done.length === 1 ? "" : "s"}`,
        undo: () => restore(done),
      });
    }
    invalidate();
  };

  const selectedAgentSub = selected
    ? [relativeTime(selected.updatedAt), staleLabel(selected)]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div
      data-slot="desktop-review"
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        maxWidth: 1180,
        margin: "0 auto",
        padding: "24px 20px 60px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={microLabel}>Review</div>
          <div style={{ fontFamily: serif, fontSize: 30, marginTop: 4 }}>
            Ready for review
          </div>
          <div style={{ fontSize: 14, color: C.t2, marginTop: 4 }}>
            {awaiting.isLoading && queue.length === 0
              ? "Checking for finished work…"
              : `${queue.length} waiting · newest first`}
          </div>
        </div>
        {stale.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {confirmBatch ? (
              <>
                <span style={{ fontSize: 12.5, color: C.t2 }}>
                  Archive {stale.length} stale? They move to the archive —
                  nothing is deleted.
                </span>
                <button
                  type="button"
                  disabled={batchBusy}
                  onClick={() => void archiveStale()}
                  style={{
                    ...primaryBtn,
                    background: C.violet,
                    opacity: batchBusy ? 0.6 : 1,
                  }}
                >
                  {batchBusy ? "Archiving…" : `Archive ${stale.length}`}
                </button>
                <button
                  type="button"
                  disabled={batchBusy}
                  onClick={() => setConfirmBatch(false)}
                  style={quietBtn}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmBatch(true)}
                style={{
                  ...chipBtn,
                  color: C.violetText,
                  borderColor:
                    "color-mix(in srgb, var(--mv1-violet) 35%, transparent)",
                  padding: "7px 14px",
                  fontSize: 12.5,
                }}
              >
                Archive {stale.length} stale
              </button>
            )}
          </div>
        ) : null}
      </div>

      {undo ? (
        <div
          style={{
            ...panel,
            marginTop: 14,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 13,
            color: C.t2,
          }}
        >
          <span style={{ flex: 1 }}>{undo.label}</span>
          <button
            type="button"
            onClick={undo.undo}
            style={{ ...quietBtn, padding: "6px 14px" }}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => setUndo(null)}
            aria-label="Dismiss"
            style={{
              background: "transparent",
              border: "none",
              color: C.t3,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            ✕
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div
          style={{
            marginTop: 12,
            fontSize: 12.5,
            color: C.amberText,
          }}
        >
          {actionError}
        </div>
      ) : null}

      {queue.length === 0 ? (
        <div
          style={{
            ...panel,
            marginTop: 18,
            padding: "40px 24px",
            textAlign: "center",
            fontSize: 14,
            color: C.t2,
            lineHeight: 1.6,
          }}
        >
          {awaiting.isLoading
            ? "Checking for finished work…"
            : "Nothing to review — when Cue finishes a piece of work, it lands here for your sign-off."}
        </div>
      ) : (
        <div
          style={{
            marginTop: 18,
            display: "grid",
            gridTemplateColumns: "minmax(260px, 330px) minmax(0, 1fr)",
            gap: 18,
            alignItems: "start",
          }}
        >
          {/* Queue */}
          <div style={{ ...panel, padding: "12px 8px 12px 4px" }}>
            {fresh.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                stale={false}
                selected={selected?.id === item.id}
                onSelect={() => select(item.id)}
                onArchive={() => doArchive(item)}
                busy={busy}
              />
            ))}

            {stale.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 12px 6px",
                }}
              >
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 9.5,
                    letterSpacing: "0.1em",
                    color: C.t3,
                  }}
                >
                  OLDER — LIKELY STALE
                </span>
                <span
                  aria-hidden
                  style={{ flex: 1, height: 1, background: C.line }}
                />
              </div>
            ) : null}

            {stale.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                stale
                selected={selected?.id === item.id}
                onSelect={() => select(item.id)}
                onArchive={() => doArchive(item)}
                busy={busy}
              />
            ))}
          </div>

          {/* Deliverable + verdict */}
          {selected ? (
            <div style={{ ...panel, padding: 22 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <StateBadge state="review" size="sm" />
                <AssessmentSignal item={selected} />
                <span style={{ fontFamily: mono, fontSize: 10.5, color: C.t3 }}>
                  {selectedAgentSub}
                </span>
              </div>
              <div
                style={{
                  fontFamily: serif,
                  fontSize: 26,
                  color: C.t1,
                  marginTop: 10,
                  lineHeight: 1.2,
                }}
              >
                {selected.title}
              </div>

              <div
                style={{
                  marginTop: 16,
                  paddingTop: 16,
                  borderTop: `1px solid ${C.line}`,
                }}
              >
                <Deliverable
                  key={selected.id}
                  assistantId={assistantId}
                  item={selected}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 9,
                  flexWrap: "wrap",
                  marginTop: 20,
                  paddingTop: 16,
                  borderTop: `1px solid ${C.line}`,
                }}
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => doApprove(selected)}
                  style={{
                    ...primaryBtn,
                    background: C.green,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {approve.isPending ? "Approving…" : "Approve → done"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => doRedo(selected, null)}
                  style={{ ...quietBtn, opacity: busy ? 0.6 : 1 }}
                >
                  {rerun.isPending ? "Redoing…" : "Redo"}
                </button>
                {selected.lastRunConversationId ? (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        routes.conversation(selected.lastRunConversationId!),
                      )
                    }
                    style={quietBtn}
                  >
                    Open the conversation
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => doArchive(selected)}
                  style={{
                    ...quietBtn,
                    marginLeft: "auto",
                    color: C.t2,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  Archive
                </button>
              </div>

              {/* Corrections — each one teaches the item, then reruns it. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  flexWrap: "wrap",
                  marginTop: 12,
                }}
              >
                <span style={{ ...microLabel, marginRight: 2 }}>
                  Redo with
                </span>
                {REDO_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    disabled={busy}
                    onClick={() => doRedo(selected, chip)}
                    style={{ ...chipBtn, opacity: busy ? 0.6 : 1 }}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
