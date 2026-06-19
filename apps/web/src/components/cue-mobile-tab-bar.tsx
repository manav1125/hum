/**
 * Cue mobile tab bar (design v0.2 / DESIGN-SPEC §4).
 *
 * On mobile the three-column desktop layout collapses, so primary navigation
 * moves to a persistent bottom tab bar: Today / Memory / Voice / Tasks, with a
 * mic affordance for Voice (full-duplex live voice via {@link useLiveVoice}).
 * Rendered only at the mobile breakpoint, as a flex-shrink-0 footer inside the
 * root layout (so it sits above the safe-area inset the shell already pads).
 */

import { Home, ListChecks, Mic, Sparkles, StopCircle } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";

interface CueMobileTabBarProps {
  /** Active assistant — needed to open a live-voice session from the mic tab. */
  assistantId: string | null;
}

interface NavTab {
  key: string;
  label: string;
  to: string;
  /** Match the active route by pathname suffix. */
  match: (pathname: string) => boolean;
}

const NAV_TABS: NavTab[] = [
  {
    key: "today",
    label: "Today",
    to: "/assistant/home",
    match: (p) => p.endsWith("/home"),
  },
  {
    key: "memory",
    label: "Memory",
    to: "/assistant/memory",
    match: (p) => p.endsWith("/memory"),
  },
  {
    key: "tasks",
    label: "Tasks",
    to: "/assistant/next-moves",
    match: (p) => p.endsWith("/next-moves"),
  },
];

export function CueMobileTabBar({ assistantId }: CueMobileTabBarProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { state, start, stop } = useLiveVoice();

  const voiceActive =
    state !== "idle" && state !== "failed" && state !== "connecting";
  const voiceConnecting = state === "connecting";

  function handleVoice() {
    if (voiceConnecting) return;
    if (voiceActive) {
      void stop();
    } else if (assistantId) {
      void start(assistantId, undefined);
    }
  }

  // Insert the Voice mic between Memory and Tasks (center-ish, like the mock).
  const tabs = [NAV_TABS[0], NAV_TABS[1]];
  const tail = [NAV_TABS[2]];

  return (
    <nav
      data-slot="cue-mobile-tab-bar"
      aria-label="Primary"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-around",
        gap: 2,
        height: 58,
        padding: "0 6px",
        background: "var(--surface-raised, var(--surface-base))",
        borderTop: "1px solid var(--border-element)",
      }}
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.key}
          label={tab.label}
          active={tab.match(pathname)}
          onClick={() => navigate(tab.to)}
          icon={
            tab.key === "today" ? (
              <Home size={20} strokeWidth={2} />
            ) : (
              <Sparkles size={20} strokeWidth={2} />
            )
          }
        />
      ))}

      <TabButton
        label="Voice"
        active={voiceActive}
        busy={voiceConnecting}
        onClick={handleVoice}
        icon={
          voiceActive ? (
            <StopCircle size={22} strokeWidth={2} />
          ) : (
            <Mic size={22} strokeWidth={2} />
          )
        }
        emphasized
      />

      {tail.map((tab) => (
        <TabButton
          key={tab.key}
          label={tab.label}
          active={tab.match(pathname)}
          onClick={() => navigate(tab.to)}
          icon={<ListChecks size={20} strokeWidth={2} />}
        />
      ))}
    </nav>
  );
}

function TabButton({
  label,
  icon,
  active,
  busy = false,
  emphasized = false,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  busy?: boolean;
  emphasized?: boolean;
  onClick: () => void;
}) {
  const color = active
    ? "var(--accent-cue)"
    : "var(--content-secondary)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-busy={busy || undefined}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        border: "none",
        background: "transparent",
        color,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span
        style={
          emphasized
            ? {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 38,
                height: 38,
                borderRadius: "26%",
                background: active ? "var(--accent-cue)" : "var(--surface-ink)",
                color: "var(--content-on-ink)",
              }
            : { display: "flex" }
        }
      >
        {icon}
      </span>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: "0.01em",
        }}
      >
        {label}
      </span>
    </button>
  );
}
