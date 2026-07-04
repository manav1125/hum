/**
 * Cue mobile tab bar.
 *
 * On mobile the three-column desktop layout collapses, so primary navigation
 * moves to a persistent bottom tab bar: Today · Projects · Create · Voice · You.
 *   - Today    → the HQ surface (`/hq`) — the one landing surface ("Home grew
 *                up", Cue-HQ-Build §1). The label stays "Today" (the word that
 *                owns the first tab) with the rings glyph; the surface adapts
 *                (pulse with zero missions, rings deck otherwise). The old
 *                `/home`, `/mission-control`, `/activity`, `/agents`,
 *                `/next-moves` all redirect to `/hq`, so Today highlights for
 *                every one of them.
 *   - Projects → the cowork surface (`/projects`): work grouped under briefs
 *                Cue reads before running each task. A primary destination.
 *   - Create   → the "what do you want to get done?" picker (`/create`).
 *   - Voice    → the full-bleed Voice mode screen (owns the live-voice session).
 *   - You      → identity hub (Channels / Memory / Settings), entered at Channels.
 * Chat is no longer a tab — it is a full-screen push reached by opening a
 * next-move card or a task. Rendered only at the mobile breakpoint, as a
 * flex-shrink-0 footer inside the root layout (so it sits above the safe-area
 * inset the shell pads). Active = brand accent; inactive = secondary at .5.
 */

import { FolderKanban, Mic, User, Wand2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/** The Today "rings" glyph (◎) — concentric status rings, per the HQ deck. */
function RingsGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

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
    to: routes.hq,
    icon: <RingsGlyph size={20} />,
    // Today owns the one landing surface (HQ) plus every legacy route that
    // now redirects there (home / mission-control / activity / agents /
    // next-moves).
    match: (p) =>
      p.includes("/hq") ||
      p.endsWith("/home") ||
      p.includes("/mission-control") ||
      p.includes("/activity") ||
      p.includes("/agents") ||
      p.includes("/next-moves"),
  },
  {
    key: "projects",
    label: "Projects",
    to: routes.projects,
    icon: <FolderKanban size={20} strokeWidth={2} />,
    match: (p) => p.includes("/projects") || p.endsWith("/work"),
  },
  {
    key: "create",
    label: "Create",
    to: routes.create,
    icon: <Wand2 size={20} strokeWidth={2} />,
    match: (p) => p.endsWith("/create"),
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
