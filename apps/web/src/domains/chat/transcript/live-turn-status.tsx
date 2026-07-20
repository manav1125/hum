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

import { Brain } from "lucide-react";
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

export interface LiveStatusView {
  /** Stable copy — drives the fade-in animation key, so it must NOT embed
   *  the ticking elapsed time. */
  text: string;
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
    return { text: "Reconnecting…" };
  }

  if (phase === "awaiting_user_input") {
    return { text: "Waiting for your input" };
  }

  // Running tool — the most recently started one is what the agent is doing.
  const tool = runningTools[runningTools.length - 1];
  if (tool) {
    const elapsed = now - tool.startedAt;
    return {
      text: toolStatusText(tool),
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
    return {
      text: thinkingStatusText(preview),
      brain: true,
    };
  }

  // Daemon activity label ("Processing bash results", "Compacting context").
  if (statusText) {
    return { text: `${statusText}…` };
  }

  if (phase === "streaming") {
    return { text: "Writing…" };
  }

  if (phase === "queued") {
    return {
      text:
        pendingQueuedCount > 0
          ? "Picking up your queued message…"
          : "Finishing up…",
    };
  }

  // No events yet — elapsed-aware fallback copy so the line never goes
  // stale-silent during long gaps (model latency, big tool steps the daemon
  // didn't announce).
  const elapsed = turnStartedAt !== null ? now - turnStartedAt : 0;
  if (elapsed < 5_000) return { text: "Cue is reading your message…" };
  if (elapsed < 20_000) return { text: "Working on it…" };
  if (elapsed < 45_000) {
    return { text: "Still working…", detail: formatElapsed(elapsed) };
  }
  return {
    text: "Still working — big step in progress",
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
  const { turnStartedAt, thinkingTail, thinkingAt, runningTools } =
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

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="live-turn-status"
      className="flex min-w-0 items-center gap-2"
    >
      {/* Left→right typing-dot wave — same phase offsets as the transcript's
          legacy thinking row / macOS TypingIndicatorView. Respects
          prefers-reduced-motion via the `.typing-dot` rule in index.css. */}
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
      {/* Keyed on the stable copy so each new status fades in; the ticking
          elapsed`detail` updates in place without re-animating. */}
      <span
        key={view.text}
        className="flex min-w-0 items-center gap-1"
        style={{ animation: "fadeInUp 0.25s ease-out" }}
      >
        {view.brain && (
          <Brain
            aria-hidden="true"
            className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
          />
        )}
        <Typography
          variant="body-small-default"
          className="min-w-0 flex-1 truncate text-left text-[var(--content-tertiary)]"
        >
          {view.text}
          {view.detail ? (
            <span className="text-[var(--content-disabled)]">
              {" "}
              · {view.detail}
            </span>
          ) : null}
        </Typography>
      </span>
    </div>
  );
}
