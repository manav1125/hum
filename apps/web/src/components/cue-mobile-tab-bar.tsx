/**
 * Cue mobile tab bar.
 *
 * On mobile the three-column desktop layout collapses, so primary navigation
 * moves to a persistent bottom tab bar matching the mobile design's clean
 * 4-item rail: Today · Tasks · Voice · You.
 *   - Today   → the Home command center (`/home`).
 *   - Mission → Mission Control, the unified five-lane board
 *               (`/mission-control`; the old `/next-moves` redirects here).
 *   - Voice  → the full-bleed Voice mode screen (owns the live-voice session).
 *   - You    → identity hub (Channels / Memory / Settings), entered at Channels.
 * Chat is no longer a tab — it is a full-screen push reached by opening a
 * next-move card or a task. Rendered only at the mobile breakpoint, as a
 * flex-shrink-0 footer inside the root layout (so it sits above the safe-area
 * inset the shell pads). Active = brand accent; inactive = secondary at .5.
 */

import { Home, LayoutDashboard, Mic, User } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { routes } from "@/utils/routes";

interface NavTab {
  key: string;
  label: string;
  to: string;
  icon: React.ReactNode;
  /** Match the active route by pathname. */
  match: (pathname: string) => boolean;
}

const TABS: NavTab[] = [
  {
    key: "today",
    label: "Today",
    to: routes.home,
    icon: <Home size={20} strokeWidth={2} />,
    match: (p) => p.endsWith("/home"),
  },
  {
    key: "mission-control",
    label: "Mission",
    to: routes.missionControl,
    icon: <LayoutDashboard size={20} strokeWidth={2} />,
    // `/next-moves` redirects to Mission Control, so highlight for both.
    match: (p) => p.includes("/mission-control") || p.includes("/next-moves"),
  },
  {
    key: "voice",
    label: "Voice",
    to: routes.voice,
    icon: <Mic size={21} strokeWidth={2} />,
    match: (p) => p.endsWith("/voice"),
  },
  {
    key: "you",
    label: "You",
    to: routes.channels,
    icon: <User size={20} strokeWidth={2} />,
    match: (p) =>
      p.includes("/channels") ||
      p.includes("/memory") ||
      p.includes("/settings") ||
      p.startsWith(routes.contacts.root),
  },
];

export function CueMobileTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

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
      {TABS.map((tab) => (
        <TabButton
          key={tab.key}
          label={tab.label}
          icon={tab.icon}
          active={tab.match(pathname)}
          onClick={() => navigate(tab.to)}
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
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
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
        color: active ? "var(--accent-cue)" : "var(--content-secondary)",
        opacity: busy ? 0.6 : active ? 1 : 0.5,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        transition: "color .15s ease, opacity .15s ease",
      }}
    >
      <span style={{ display: "flex" }}>{icon}</span>
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
