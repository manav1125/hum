import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { ChevronDown, Mic } from "lucide-react";

import { VoiceOrb } from "@vellumai/design-library/components/voice-orb";

import {
  companionOpenCue,
  companionTalk,
  getCompanionStatus,
  setCompanionExpanded,
  subscribeCompanionStatus,
  type AssistantStatus,
} from "@/domains/companion/companion-bridge";

/**
 * Floating desktop companion (slice 1) — the page rendered inside the
 * Electron companion BrowserWindow: a small always-on-top, non-activating
 * panel pinned to a screen corner (see `apps/macos/src/main/companion-window.ts`).
 *
 * Two presentations, both painted on a transparent canvas:
 *
 *  - **Collapsed** (72×72 window): the Cue orb. The thin ring around the
 *    orb is a CSS drag region (`-webkit-app-region: drag`) so the user can
 *    reposition the window; the orb itself is a click target (drag regions
 *    swallow clicks, so the two cannot overlap) that expands the card.
 *  - **Expanded** (260×148 window): a mini card with a drag-handle strip,
 *    the orb + status line, and two actions — "Talk" (IPC → surface the
 *    main window's voice room) and "Open Cue" (IPC → focus main window).
 *    No chat composer in slice 1.
 *
 * The window resize itself is main's job — the page only reports the
 * desired presentation over `setCompanionExpanded` and renders whichever
 * layout matches its local state.
 *
 * Status-aware: the orb reuses the assistant status the SPA already
 * publishes to the Electron main process for the tray (idle / thinking /
 * error…), pushed back to this window over the companion bridge — no
 * polling of its own. `thinking` renders the orb's thinking motion
 * (active run); everything else renders the calm idle core.
 *
 * Standalone route (no auth, no RootLayout) like Quick Input and the
 * dictation overlay, so the panel loads instantly. Off-Electron the bridge
 * no-ops and the page is an inert orb.
 *
 * Design TODO (slice 2+): replace the plain status ring with the mascot
 * treatment from the companion design exploration (status-driven
 * animations, attention nudges), and light up `listening`/`speaking` once
 * voice runs inline in the companion.
 */

const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** Map the tray's assistant status onto the orb's motion vocabulary. */
const orbStateFor = (status: AssistantStatus): "idle" | "thinking" =>
  status === "thinking" ? "thinking" : "idle";

const STATUS_LABEL: Record<AssistantStatus, string> = {
  idle: "Idle",
  thinking: "Working…",
  error: "Needs attention",
  disconnected: "Disconnected",
  authFailed: "Reconnect needed",
};

export function CompanionPage() {
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeCompanionStatus(setStatus);
    // The route chunk loads lazily after the window is created, so the
    // first pushed status can predate the subscription. Pull the current
    // one to catch up — pushed statuses are newer, so never overwrite one.
    let sawPush = false;
    const wrapped = (pulled: AssistantStatus | null) => {
      if (pulled && !sawPush) setStatus(pulled);
    };
    const markPush = subscribeCompanionStatus(() => {
      sawPush = true;
    });
    void getCompanionStatus().then(wrapped);
    return () => {
      unsubscribe();
      markPush();
    };
  }, []);

  const applyExpanded = useCallback((value: boolean) => {
    setExpanded(value);
    void setCompanionExpanded(value);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        applyExpanded(false);
      }
    },
    [applyExpanded],
  );

  if (!expanded) {
    return (
      // The 8px padding ring is the drag region; the orb button inside it
      // is no-drag so clicks land.
      <div
        className="flex h-screen w-screen items-center justify-center bg-transparent p-2"
        style={DRAG_REGION}
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          aria-label="Expand Cue companion"
          onClick={() => applyExpanded(true)}
          className="rounded-full outline-none"
          style={NO_DRAG_REGION}
        >
          <VoiceOrb state={orbStateFor(status)} size={52} label={STATUS_LABEL[status]} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex h-screen w-screen items-stretch bg-transparent p-1"
      onKeyDown={handleKeyDown}
    >
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-base)] shadow-lg">
        {/* Drag-handle strip: the card's only drag region. */}
        <div
          className="flex items-center justify-between px-3 pt-2"
          style={DRAG_REGION}
        >
          <span className="text-[11px] font-medium text-[var(--content-tertiary)]">
            Cue
          </span>
          <button
            type="button"
            aria-label="Collapse Cue companion"
            onClick={() => applyExpanded(false)}
            className="flex size-5 items-center justify-center rounded-full text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
            style={NO_DRAG_REGION}
          >
            <ChevronDown size={14} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 items-center gap-3 px-3">
          <VoiceOrb
            state={orbStateFor(status)}
            size={44}
            label={STATUS_LABEL[status]}
            className="shrink-0"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--content-default)]">
              Cue
            </p>
            <p
              className="truncate text-[11px] text-[var(--content-secondary)]"
              data-testid="companion-status"
            >
              {STATUS_LABEL[status]}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 pb-3" style={NO_DRAG_REGION}>
          <button
            type="button"
            onClick={() => {
              void companionTalk();
              applyExpanded(false);
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--surface-accent)] px-3 py-1.5 text-xs font-medium text-[var(--content-on-accent)]"
          >
            <Mic size={13} />
            Talk
          </button>
          <button
            type="button"
            onClick={() => {
              void companionOpenCue();
              applyExpanded(false);
            }}
            className="flex flex-1 items-center justify-center rounded-full border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--content-default)]"
          >
            Open Cue
          </button>
        </div>
      </div>
    </div>
  );
}
