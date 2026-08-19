/**
 * MobileLiveActivity — the "Cue is genuinely working" block pinned above the
 * mobile composer while a turn is in flight.
 *
 * Replaces the dead wait (a bare collapsed "Thinking · 4 steps" row somewhere
 * up the transcript) with a living, glanceable activity strip:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ ▮▮▮  Reading NextGen MENA Fund v2.pdf…       │
 *   │      Step 4 · 1m 12s                         │
 *   │  ✓ Searching the web                          │
 *   │  ✓ Fetching justcue.ai                        │
 *   │  ● Reading NextGen MENA Fund v2.pdf           │
 *   └──────────────────────────────────────────────┘
 *
 * Signal sources (all existing):
 *   - headline: `deriveLiveStatus` — the same ladder the in-transcript
 *     status line uses (tool activity → fresh thinking preview → daemon
 *     statusText → phase copy → elapsed-aware "still working" honesty).
 *   - steps: the live-status-store's per-conversation step history
 *     (running + finished tool calls), so fast steps are visible too.
 *   - elapsed: ticking clock off `turnStartedAt` (never Date.now() in
 *     render — lazy init + interval, matching LiveTurnStatus).
 *
 * Reliability affordance: when the turn has produced NO live signal for
 * `WATCHDOG_SILENCE_MS` the block adds a quiet "Check status" button that
 * runs the real reconcile path (`requestActiveReconcile`) — it re-fetches
 * the conversation and, if the server says the turn completed while we
 * weren't looking, renders the reply and clears the spinner. It never
 * cancels anything.
 *
 * Motion: transform/opacity only; the mv3 reduced-motion rule (scoped via
 * `data-mv3`) freezes the pulse bars, and the local fade keyframe carries
 * its own `prefers-reduced-motion` guard.
 */

import { Check, MessageCircleQuestion } from "lucide-react";

import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { useLiveActivity } from "@/domains/chat/components/use-live-activity";
import type { LiveStep } from "@/domains/chat/live-status-store";
import { formatElapsed } from "@/domains/chat/transcript/live-turn-status";
import { truncate } from "@/domains/chat/utils/truncate";
import { LivePulseBadge } from "@/mobile-v3/work-kit";

const STEP_LABEL_MAX_CHARS = 56;

/** Humanize one step-history entry (mirrors the status line's tool copy). */
function stepLabelText(step: LiveStep): string {
  const name = step.toolName.toLowerCase();
  if (name === "web_search") return "Searching the web";
  if (name === "web_fetch") return "Reading a web page";
  const { title, info, activity } = deriveStepLabelFromName(
    step.toolName,
    step.input,
  );
  const base = activity || (info ? `${title} · ${info}` : title);
  return truncate(base, STEP_LABEL_MAX_CHARS);
}

const BLOCK_STYLES = `
@keyframes mlaFadeUp {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  [data-mla-fade] { animation: none !important; }
}
`;

export interface MobileLiveActivityProps {
  /** External activity hint for restored / external-channel turns where the
   *  local turn reducer never activated (same flag the transcript's status
   *  line receives via `liveStatusFallbackActive`). */
  fallbackActive?: boolean;
}

export function MobileLiveActivity({
  fallbackActive = false,
}: MobileLiveActivityProps) {
  // Every piece of state here is shared with the desktop strip — see
  // `use-live-activity.ts`. Only the markup below is mobile's.
  const {
    view,
    isWaiting,
    visibleSteps,
    subParts,
    showWatchdog,
    silentFor,
    checking,
    checkStatus: handleCheckStatus,
  } = useLiveActivity(fallbackActive);

  if (!view) return null;

  return (
    <div
      data-mv3
      data-testid="mobile-live-activity"
      role="status"
      aria-live="polite"
      style={{
        borderRadius: 18,
        background: "var(--mv3-glass)",
        border: "1px solid var(--mv3-glass-border)",
        boxShadow: "var(--mv3-glass-shadow)",
        padding: "11px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: BLOCK_STYLES }} />

      {/* Headline: indicator + current activity + step/elapsed micro-line.
          "Waiting on you" swaps the working pulse for a static amber question
          glyph so a pending question can never be mistaken for a running
          turn. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {isWaiting ? (
          <MessageCircleQuestion
            aria-hidden
            size={22}
            style={{ color: "var(--mv3-amber)", flexShrink: 0 }}
          />
        ) : (
          <LivePulseBadge size={22} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Keyed on the rendered copy so each new status fades in; the
              ticking elapsed line updates in place without re-animating. */}
          <div
            key={isWaiting ? view.label : view.text}
            data-mla-fade
            style={{
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.3,
              color: isWaiting ? "var(--mv3-amber)" : "var(--mv3-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              animation: "mlaFadeUp .25s ease-out both",
            }}
          >
            {isWaiting ? view.label : view.text}
            {view.detail ? (
              <span style={{ color: "var(--mv3-muted)", fontWeight: 400 }}>
                {" "}
                · {view.detail}
              </span>
            ) : null}
          </div>
          {subParts.length > 0 ? (
            <div
              style={{
                fontSize: 11,
                color: "var(--mv3-micro)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {subParts.join(" · ")}
            </div>
          ) : null}
        </div>
      </div>

      {/* Latest steps mini-stream — quiet, newest last, older ones dim.
          Hidden while waiting on the user: the pending ask_question call is
          still "running", and a pulsing running-dot would undercut the
          message that Cue has stopped and needs them. */}
      {!isWaiting && visibleSteps.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            paddingLeft: 2,
          }}
        >
          {visibleSteps.map((step, i) => {
            const isLatest = i === visibleSteps.length - 1;
            const running = step.endedAt === null;
            return (
              <div
                key={step.toolUseId}
                data-mla-fade
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 11.5,
                  lineHeight: 1.35,
                  color: isLatest ? "var(--mv3-muted)" : "var(--mv3-muted)",
                  opacity: isLatest ? 1 : 0.75,
                  animation: "mlaFadeUp .25s ease-out both",
                }}
              >
                {running ? (
                  <span
                    aria-hidden
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: "var(--mv3-accent)",
                      flexShrink: 0,
                      animation: "typing-dot-pulse 1s ease-in-out infinite",
                    }}
                  />
                ) : (
                  <Check
                    aria-hidden
                    size={10}
                    strokeWidth={3}
                    style={{ color: "var(--mv3-green)", flexShrink: 0 }}
                  />
                )}
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {stepLabelText(step)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Watchdog — long silence gets an honest manual re-sync, never an
          auto-cancel. */}
      {showWatchdog ? (
        <div
          data-mla-fade
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            borderTop: "1px solid var(--mv3-line)",
            paddingTop: 8,
            animation: "mlaFadeUp .25s ease-out both",
          }}
        >
          <span style={{ fontSize: 11.5, color: "var(--mv3-micro)" }}>
            {`Nothing new for ${formatElapsed(silentFor)} — still working`}
          </span>
          <button
            type="button"
            onClick={handleCheckStatus}
            disabled={checking}
            style={{
              flexShrink: 0,
              border: "1px solid var(--mv3-btn2-border)",
              background: "var(--mv3-btn2-bg)",
              color: "var(--mv3-text)",
              borderRadius: 999,
              padding: "5px 12px",
              fontSize: 11.5,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: checking ? "default" : "pointer",
              opacity: checking ? 0.6 : 1,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {checking ? "Checking…" : "Check status"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
