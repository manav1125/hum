/**
 * LiveTurnStatus — the persistent "show our work" status line rendered next
 * to the assistant avatar while a turn is active.
 *
 * Replaces the dead-air windows (turn accepted → first token, gaps between
 * thinking blocks, long tool executions) with live, textual signal:
 *
 *   "Cue is reading your message…"            (turn just accepted)
 *   🧠 <first ~80 chars of the live thinking> (thinking deltas streaming)
 *   "Searching the web… · 12s"                (tool running, humanized)
 *   "Processing bash results…"                (daemon activity statusText)
 *   "Writing…"                                (text streaming)
 *   "Still working — big step in progress (1m 10s)"  (no events, elapsed-aware)
 *
 * Always animated (typing dots + fade-in on copy changes) and always
 * textual — never a bare pulsing logo. Renders `null` when no turn is
 * active. The signal comes from `useTurnStore` (phase, daemon statusText,
 * queue depth) and the per-conversation slice of `useLiveStatusStore`
 * (turn start time, thinking preview, running tools) for the conversation
 * being VIEWED — other conversations' concurrently-streaming turns keep
 * their signal under their own key and never reach this line. See
 * `live-status-store.ts` for the writers.
 *
 * Styling mirrors the existing thinking affordances: `typing-dot-pulse`
 * dots (transcript thinking row), Brain-glyph + tertiary text preview
 * (MultiActivityGroup collapsed header), semantic theme tokens throughout
 * so light/dark and the mobile `.cue-mchat` re-binding both work.
 */

import { Brain, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import {
  useLiveStatusForConversation,
  useLiveStatusStore,
  type LiveToolRun,
} from "@/domains/chat/live-status-store";
import {
  isSending,
  useTurnStore,
  type TurnPhase,
} from "@/domains/chat/turn-store";
import { truncate } from "@/domains/chat/utils/truncate";
import { useConversationStore } from "@/stores/conversation-store";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";

// ---------------------------------------------------------------------------
// Pure derivation (exported for tests)
// ---------------------------------------------------------------------------

/** Max characters of live thinking text shown in the status line. Mirrors
 *  the MultiActivityGroup collapsed header's `HEADER_INFO_MAX_CHARS`. */
const THINKING_PREVIEW_MAX_CHARS = 80;

/** Show a ticking elapsed suffix on a tool run once it has been going this
 *  long — short tool calls stay clean. */
const TOOL_ELAPSED_THRESHOLD_MS = 8_000;

/** A thinking delta within this window means reasoning is genuinely live,
 *  so the preview wins over the generic streaming copy. */
const THINKING_FRESH_MS = 3_000;

/**
 * Error-ish markers in the live thinking tail. The status line never shows
 * raw model thinking verbatim (UAT: it surfaced ops-speak like "Bash tool is
 * erroring — same recurring issue…"); instead the tail is classified into a
 * calm, honest tier: working through a snag vs. plain thinking.
 */
const THINKING_SNAG_RE =
  /\b(error|errors|erroring|errored|fail|fails|failing|failed|failure|retry|retrying|broken|bug|issue|problem|snag|stuck|crash|crashed|exception)\b/i;

/**
 * Calm user-facing copy for a fresh thinking tail. Honest about trouble
 * (snag tier) without leaking the model's internal monologue.
 */
export function thinkingStatusText(preview: string): string {
  return THINKING_SNAG_RE.test(preview)
    ? "Hit a snag — working through it…"
    : "Thinking it through…";
}

/**
 * The single most important word about the turn, at a glance. Drives the
 * status line's colour + indicator so the user can tell, without reading,
 * whether Cue is running (`working`/`thinking`), stuck waiting on THEM
 * (`waiting` — the one that must never be confused with working), unable to
 * observe progress (`blocked`), or done (`stopped`).
 */
export type LiveState =
  | "working"
  | "waiting"
  | "thinking"
  | "blocked"
  | "stopped";

export interface LiveStatusView {
  /** The one-word state. Drives the indicator + colour treatment; `waiting`
   *  is rendered unmistakably distinct from `working`. */
  state: LiveState;
  /** The prominent state word shown to the user ("Working", "Waiting on
   *  you", …). Derived from `state` but branch-specific where a truer word
   *  exists (e.g. "Reconnecting" for a dropped stream). */
  label: string;
  /** Full descriptive headline — unchanged legacy field, still the single
   *  string the mobile live-activity block renders. Drives the fade-in
   *  animation key, so it must NOT embed the ticking elapsed time. */
  text: string;
  /** The current action in plain words, WITHOUT the state word baked in
   *  ("Searching the web…", "npm run build") — or null when there is no
   *  distinct action beyond the state itself. The desktop line renders
   *  `label · activity`; null keeps it to just the state word + elapsed. */
  activity: string | null;
  /** Optional ticking suffix (elapsed time), rendered without re-animating. */
  detail?: string;
  /** Show the Brain glyph (thinking preview), mirroring the activity card. */
  brain?: boolean;
}

/** "12s" / "1m 10s" formatting shared with the mobile live-activity block. */
export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

/**
 * Compact token count for the quiet burn-down counter ("820", "8.2k",
 * "1.3M"). Shared with the mobile live-activity block. Effort, not progress —
 * kept subordinate to the state + current action in both surfaces.
 */
export function formatTokens(n: number): string {
  if (n < 1_000) return `${Math.max(0, Math.round(n))}`;
  if (n < 1_000_000) {
    const k = n / 1_000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/**
 * The quiet secondary "effort" line — step count and the turn's token
 * burn-down. Explicitly subordinate to the state word + current action: the
 * user asked for a token/time read "the way Claude does it", but tokens are
 * effort, not progress. Returns null when there is nothing to show yet.
 */
export function formatTurnMeta(stepCount: number, turnTokens: number): string | null {
  const parts: string[] = [];
  if (stepCount > 0) parts.push(`${stepCount} ${stepCount === 1 ? "step" : "steps"}`);
  if (turnTokens > 0) parts.push(`${formatTokens(turnTokens)} tokens`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Humanize a running tool into present-tense status copy. */
function toolStatusText(run: LiveToolRun): string {
  const name = run.toolName.toLowerCase();
  if (name === "web_search") return "Searching the web…";
  if (name === "web_fetch") return "Reading a web page…";
  const { title, info, activity } = deriveStepLabelFromName(
    run.toolName,
    run.input,
  );
  // Prefer the daemon's rich activity sentence ("Checking deploy status"),
  // then the title+info pair ("Working · npm run build"), then the title.
  const base = activity || (info ? `${title} · ${info}` : title);
  return `${truncate(base, THINKING_PREVIEW_MAX_CHARS)}…`;
}

export interface DeriveLiveStatusInput {
  phase: TurnPhase;
  /** Daemon-provided activity label (turn-store `statusText`). */
  statusText: string | null;
  pendingQueuedCount: number;
  thinkingTail: string;
  thinkingAt: number | null;
  runningTools: LiveToolRun[];
  turnStartedAt: number | null;
  /** Current wall-clock ms — from ticking state, never `Date.now()` in render. */
  now: number;
  /** External activity hint (restored/external-channel turns where the local
   *  turn reducer never activated). */
  fallbackActive: boolean;
  /** Whether the SSE event stream is currently connected
   *  (`useSSEConnectedStore`). While it's down no progress signal can
   *  arrive, so the ladder shows "Reconnecting…" instead of letting a stale
   *  "Still working…" claim progress that cannot be observed. Defaults to
   *  `true` when omitted (callers without connection awareness). */
  sseConnected?: boolean;
}

export function deriveLiveStatus(
  input: DeriveLiveStatusInput,
): LiveStatusView | null {
  const {
    phase,
    statusText,
    pendingQueuedCount,
    thinkingTail,
    thinkingAt,
    runningTools,
    turnStartedAt,
    now,
    fallbackActive,
    sseConnected = true,
  } = input;

  const active = isSending(phase) || fallbackActive;
  if (!active) return null;

  // Stream gone while the turn looks active: every rung below reports
  // progress we can no longer observe, so say what is actually happening.
  if (!sseConnected) {
    return {
      state: "blocked",
      label: "Reconnecting",
      text: "Reconnecting…",
      activity: null,
    };
  }

  // Waiting on YOU — a pending question/approval. This is the one state the
  // user has repeatedly been unable to distinguish from "working", so it is
  // its own state with a distinct (amber, un-animated) treatment downstream.
  if (phase === "awaiting_user_input") {
    return {
      state: "waiting",
      label: "Waiting on you",
      text: "Waiting for your input",
      activity: null,
    };
  }

  // Running tool — the most recently started one is what the agent is doing.
  const tool = runningTools[runningTools.length - 1];
  if (tool) {
    const elapsed = now - tool.startedAt;
    const text = toolStatusText(tool);
    return {
      state: "working",
      label: "Working",
      text,
      activity: text,
      ...(elapsed >= TOOL_ELAPSED_THRESHOLD_MS
        ? { detail: formatElapsed(elapsed) }
        : {}),
    };
  }

  // Live thinking signal. Wins over the generic streaming copy only while
  // deltas are actually fresh, so a stale block never masks real progress.
  // The tail itself is NEVER surfaced verbatim — it's classified into calm
  // derived copy (thinking vs. snag tier) so raw model reasoning can't leak
  // into the UI.
  const preview = thinkingTail.trim();
  const thinkingIsFresh =
    thinkingAt !== null && now - thinkingAt < THINKING_FRESH_MS;
  if (preview && (phase !== "streaming" || thinkingIsFresh)) {
    const snag = THINKING_SNAG_RE.test(preview);
    return {
      state: "thinking",
      label: "Thinking",
      text: thinkingStatusText(preview),
      // The calm "Thinking it through…" adds nothing beyond the "Thinking"
      // word, so it's dropped from the desktop line; the honest snag note is
      // kept because it carries real signal.
      activity: snag ? "working through a snag" : null,
      brain: true,
    };
  }

  // Daemon activity label ("Processing bash results", "Compacting context").
  if (statusText) {
    return {
      state: "working",
      label: "Working",
      text: `${statusText}…`,
      activity: statusText,
    };
  }

  if (phase === "streaming") {
    return {
      state: "working",
      label: "Working",
      text: "Writing…",
      activity: "writing the reply",
    };
  }

  if (phase === "queued") {
    const text =
      pendingQueuedCount > 0
        ? "Picking up your queued message…"
        : "Finishing up…";
    return {
      state: "working",
      label: "Working",
      text,
      activity: pendingQueuedCount > 0 ? "picking up your queued message" : null,
    };
  }

  // No events yet — elapsed-aware fallback copy so the line never goes
  // stale-silent during long gaps (model latency, big tool steps the daemon
  // didn't announce).
  const elapsed = turnStartedAt !== null ? now - turnStartedAt : 0;
  if (elapsed < 5_000) {
    return {
      state: "working",
      label: "Working",
      text: "Cue is reading your message…",
      activity: "reading your message",
    };
  }
  if (elapsed < 20_000) {
    return {
      state: "working",
      label: "Working",
      text: "Working on it…",
      activity: null,
    };
  }
  if (elapsed < 45_000) {
    return {
      state: "working",
      label: "Working",
      text: "Still working…",
      activity: null,
      detail: formatElapsed(elapsed),
    };
  }
  return {
    state: "working",
    label: "Working",
    text: "Still working — big step in progress",
    activity: null,
    detail: formatElapsed(elapsed),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface LiveTurnStatusProps {
  /** True when the conversation is known to be processing even though the
   *  local turn reducer is idle (restored after a conversation switch, or an
   *  external-channel turn streaming into this tab). Callers pass the same
   *  gated flag that used to drive the standalone thinking-dots row. */
  fallbackActive?: boolean;
}

export function LiveTurnStatus({
  fallbackActive = false,
}: LiveTurnStatusProps) {
  const phase = useTurnStore.use.phase();
  const statusText = useTurnStore.use.statusText();
  const pendingQueuedCount = useTurnStore.use.pendingQueuedCount();

  // The line renders inside the ACTIVE conversation's transcript, so it
  // must only project that conversation's live slice — a concurrently
  // running background conversation's thinking/tool signal lives under its
  // own key in the store and never reaches this selector.
  const activeConversationId = useConversationStore.use.activeConversationId();
  const { turnStartedAt, thinkingTail, thinkingAt, runningTools, stepCount, turnTokens } =
    useLiveStatusForConversation(activeConversationId);
  const sseConnected = useSSEConnectedStore.use.isConnected();

  const active = isSending(phase) || fallbackActive;

  // Ticking clock for elapsed-aware copy. Initialised lazily and advanced
  // from an interval — `Date.now()` never runs in the render body.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);

  // Restored/external turns never pass through the turn reducer's
  // inactive→active transition, so the store has no start stamp for the
  // viewed conversation — take one the moment this component sees activity.
  useEffect(() => {
    if (active && activeConversationId && turnStartedAt === null) {
      useLiveStatusStore.getState().noteTurnStart(activeConversationId);
    }
  }, [active, activeConversationId, turnStartedAt]);

  const view = deriveLiveStatus({
    phase,
    statusText,
    pendingQueuedCount,
    thinkingTail,
    thinkingAt,
    runningTools,
    turnStartedAt,
    now,
    fallbackActive,
    sseConnected,
  });
  if (!view) return null;

  const isWaiting = view.state === "waiting";
  // Token/step burn-down is meaningful only while Cue is actually running —
  // never next to "Waiting on you" (it would read as ongoing work) or a
  // dropped stream (the counter is frozen and would look stalled).
  const meta =
    view.state === "working" || view.state === "thinking"
      ? formatTurnMeta(stepCount, turnTokens)
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="live-turn-status"
      data-live-state={view.state}
      className="flex min-w-0 items-center gap-2"
    >
      {/* Leading indicator. "Waiting on you" is deliberately NOT animated —
          the typing-dot wave means "actively working", so a pending question
          gets a static amber question glyph instead, the single strongest cue
          that the ball is in the user's court. */}
      {isWaiting ? (
        <MessageCircleQuestion
          aria-hidden="true"
          className="size-4 shrink-0 text-[var(--system-mid-strong)]"
        />
      ) : view.brain ? (
        <Brain
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
        />
      ) : (
        <span aria-hidden className="flex shrink-0 items-center gap-[3px]">
          {([-0.333, 0, -0.667] as const).map((delay, i) => (
            <span
              key={i}
              className="typing-dot block h-1.5 w-1.5 rounded-full bg-[var(--content-tertiary)]"
              style={{
                animation: "typing-dot-pulse 1s ease-in-out infinite",
                animationDelay: `${delay}s`,
              }}
            />
          ))}
        </span>
      )}
      {/* Keyed on the state word so each new status fades in; the ticking
          elapsed `detail` + meta update in place without re-animating. */}
      <span
        key={view.label}
        className="flex min-w-0 items-center gap-1"
        style={{ animation: "fadeInUp 0.25s ease-out" }}
      >
        <Typography
          variant="body-small-default"
          className="min-w-0 flex-1 truncate text-left"
        >
          {/* The single most important word, colour-coded by state. Amber for
              "Waiting on you" so it is unmistakable against the tertiary grey
              of a working line. */}
          <span
            className={
              isWaiting
                ? "font-medium text-[var(--system-mid-strong)]"
                : "text-[var(--content-secondary)]"
            }
          >
            {view.label}
          </span>
          {view.activity ? (
            <span className="text-[var(--content-tertiary)]">
              {" "}
              · {view.activity}
            </span>
          ) : null}
          {view.detail ? (
            <span className="text-[var(--content-disabled)]">
              {" "}
              · {view.detail}
            </span>
          ) : null}
          {meta ? (
            <span className="text-[var(--content-disabled)]"> · {meta}</span>
          ) : null}
        </Typography>
      </span>
    </div>
  );
}
