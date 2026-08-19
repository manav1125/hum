/**
 * DesktopLiveActivity — the "Cue is genuinely working" strip pinned above the
 * desktop composer while a turn is in flight.
 *
 * Desktop already had a live status line, but it renders inside the
 * transcript next to the assistant avatar, so it scrolls away the moment the
 * conversation is longer than the viewport. The result was that a turn
 * grinding through a twenty-minute tool run and a turn that had died looked
 * exactly the same: a collapsed "Worked for 20m · 2 steps" row with nothing
 * moving. Users learned to reload the page to find out which it was.
 *
 * This is the mobile block's affordance on the surface most people use:
 * always in view, always animated while work is happening, and — after
 * {@link WATCHDOG_SILENCE_MS} of no signal at all — a quiet Check status
 * button that re-fetches and settles the turn rather than leaving them to
 * guess. It never cancels anything.
 *
 * Presentation only; every piece of state comes from {@link useLiveActivity},
 * shared with the mobile block so the two surfaces cannot disagree about
 * whether Cue is working.
 */

import { Check, MessageCircleQuestion } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { useLiveActivity } from "@/domains/chat/components/use-live-activity";
import type { LiveStep } from "@/domains/chat/live-status-store";
import { truncate } from "@/domains/chat/utils/truncate";

const STEP_LABEL_MAX_CHARS = 72;

/** Humanize one step-history entry (mirrors the status line's tool copy). */
function stepLabelText(step: LiveStep): string {
  const name = step.toolName.toLowerCase();
  if (name === "web_search") return "Searching the web";
  if (name === "web_fetch") return "Reading a web page";
  const { title, info, activity } = deriveStepLabelFromName(
    step.toolName,
    step.input,
  );
  return activity || (info ? `${title} · ${info}` : title);
}

export interface DesktopLiveActivityProps {
  /**
   * Local proof of an active turn when the turn reducer has gone idle
   * mid-turn — see the note at the mobile call site. Without it the strip
   * goes dark during exactly the long waits it exists for.
   */
  fallbackActive?: boolean;
}

export function DesktopLiveActivity({
  fallbackActive = false,
}: DesktopLiveActivityProps) {
  const {
    view,
    isWaiting,
    visibleSteps,
    subParts,
    showWatchdog,
    checking,
    checkStatus,
  } = useLiveActivity(fallbackActive);

  if (!view) return null;

  return (
    <div
      data-testid="desktop-live-activity"
      role="status"
      aria-live="polite"
      className="mb-2 flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface-raised px-3.5 py-2.5"
    >
      {/* Headline: indicator + current activity + step/elapsed micro-line.
          "Waiting on you" swaps the working pulse for a static amber question
          glyph — a pending question must never read as a running turn. */}
      <div className="flex items-center gap-2.5">
        {isWaiting ? (
          <MessageCircleQuestion
            aria-hidden
            className="h-[18px] w-[18px] shrink-0 text-amber-500"
          />
        ) : (
          <span
            aria-hidden
            className="typing-dot-pulse shrink-0"
            data-testid="desktop-live-activity-pulse"
          />
        )}
        <div className="min-w-0 flex-1">
          <Typography
            // Keyed on the copy so each new status fades in; the ticking
            // elapsed line updates in place without re-animating.
            key={isWaiting ? view.label : view.text}
            variant="body-small-emphasised"
            className={`truncate font-semibold ${
              isWaiting ? "text-amber-500" : "text-text-primary"
            }`}
          >
            {isWaiting ? view.label : view.text}
            {view.detail ? (
              <span className="font-normal text-text-tertiary">
                {" "}
                · {view.detail}
              </span>
            ) : null}
          </Typography>
          {subParts.length > 0 ? (
            <Typography
              variant="label-small-default"
              className="tabular-nums text-text-tertiary"
            >
              {subParts.join(" · ")}
            </Typography>
          ) : null}
        </div>
        {showWatchdog ? (
          <button
            type="button"
            onClick={checkStatus}
            disabled={checking}
            className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-60"
          >
            {checking ? "Checking…" : "Check status"}
          </button>
        ) : null}
      </div>

      {/* Latest steps — quiet, newest last, older ones dim. Hidden while
          waiting on the user: the pending ask_question call is still
          "running", and a running dot would undercut the message that Cue
          has stopped and needs them. */}
      {!isWaiting && visibleSteps.length > 0 ? (
        <div className="flex flex-col gap-1 pl-0.5">
          {visibleSteps.map((step, i) => {
            const isLatest = i === visibleSteps.length - 1;
            const running = step.endedAt === null;
            return (
              <div
                key={step.toolUseId}
                className={`flex items-center gap-2 text-xs text-text-tertiary ${
                  isLatest ? "opacity-100" : "opacity-70"
                }`}
              >
                {running ? (
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-text-tertiary"
                  />
                ) : (
                  <Check aria-hidden className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">
                  {truncate(stepLabelText(step), STEP_LABEL_MAX_CHARS)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
