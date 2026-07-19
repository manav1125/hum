/**
 * TabBarV3 — the mv3 floating glass tab bar (spec frames 1 dark / 12 light):
 * five slots `Today · Projects · + · Voice · You` with the raised accent
 * center +. Replaces the flat mv1 bar ON MOBILE ONLY (root-layout renders it
 * behind `useIsMobile()`); desktop navigation is untouched.
 *
 * Spec values: pill bg rgba(22,26,36,.82)/rgba(255,255,255,.85), hairline
 * border, radius 28, padding 9px 8px, blur(24px), shadow 0 18px 40px -18px;
 * items min-width 56, icon 21–22, label 9.5px (active = microlabel color,
 * weight 600; inactive dimmed to .55/.5); Today's icon is the CueRing mark
 * (stroke 46 / dot 34 at this size); the + is a 46px gradient circle raised
 * −18px with a 3px bg-colored keyline.
 *
 * Routing carries over 1:1 from the mv1 bar (`cue-mobile-tab-bar.tsx`):
 * Today → /hq (+ legacy redirect matches), Projects → /projects, + → /create
 * (the sheet conversion is a later phase), Voice → /voice, You → /channels.
 * The bar hides on surfaces that own their bottom dock (Voice, chat).
 *
 * Safe area: the wrapper extends the bar's material UNDER the home indicator
 * (the mv1 bar stopped at the safe-area line — audit flag). The root layout
 * pads the shell by the bottom inset, so the wrapper claws that padding back
 * with a negative margin and re-pads itself, painting `--mv3-bg` down to the
 * physical bottom edge.
 */
import { useLocation, useNavigate } from "react-router";

import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { CueRing } from "./cue-ring";

const SAFE_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";

/** Spec stroke geometry for the flat nav glyphs. */
const GLYPH = {
  width: 21,
  height: 21,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
} as const;

function ProjectsGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="4" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  );
}

function VoiceGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <path d="M12 3v10" />
      <path d="M8 7v5M16 7v5M4 9v2M20 9v2" />
      <circle cx="12" cy="18" r="2.6" />
    </svg>
  );
}

function YouGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5 20c1.4-3.2 4-4.8 7-4.8s5.6 1.6 7 4.8" />
    </svg>
  );
}

/** Surfaces that own their own bottom dock — bar hides there (carried over
 *  from the mv1 bar so those screens keep rendering edge-to-edge). */
function tabBarHidden(pathname: string): boolean {
  return pathname.endsWith("/voice") || pathname.includes("/conversations");
}

interface V3Tab {
  key: string;
  label: string;
  to: string;
  icon: (active: boolean) => React.ReactNode;
  match: (pathname: string) => boolean;
}

const TABS: V3Tab[] = [
  {
    key: "today",
    label: "Today",
    to: routes.hq,
    // The mark itself is the Today icon — ring stroke swaps to the active
    // color, the dot stays accent (DNA).
    icon: (active) => (
      <CueRing
        size={22}
        stroke={active ? "var(--mv3-ring-active)" : "currentColor"}
        strokeWidth={46}
        dotRadius={34}
      />
    ),
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
    icon: () => <ProjectsGlyph />,
    match: (p) => p.includes("/projects") || p.endsWith("/work"),
  },
  {
    key: "voice",
    label: "Voice",
    to: routes.voice,
    icon: () => <VoiceGlyph />,
    match: (p) => p.endsWith("/voice"),
  },
  {
    key: "you",
    label: "You",
    to: routes.channels,
    icon: () => <YouGlyph />,
    match: (p) =>
      p.includes("/channels") ||
      p.includes("/memory") ||
      p.includes("/settings") ||
      p.includes("/contacts"),
  },
];

function TabItem({ tab, pathname }: { tab: V3Tab; pathname: string }) {
  const navigate = useNavigate();
  const active = tab.match(pathname);
  return (
    <button
      type="button"
      onClick={() => {
        haptic.light();
        navigate(tab.to);
      }}
      aria-current={active ? "page" : undefined}
      className="cue-pressable"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        minWidth: 56,
        minHeight: 44,
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        color: "var(--mv3-text)",
        opacity: active ? 1 : "var(--mv3-tab-dim)",
        transition: "opacity .15s ease",
      }}
    >
      {tab.icon(active)}
      <span
        style={{
          fontSize: 9.5,
          fontWeight: active ? 600 : 400,
          color: active ? "var(--mv3-micro)" : "var(--mv3-text)",
        }}
      >
        {tab.label}
      </span>
    </button>
  );
}

export function TabBarV3() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  if (tabBarHidden(pathname)) return null;

  const createActive = pathname.endsWith("/create");

  return (
    <nav
      data-slot="cue-mobile-tab-bar"
      data-mv3
      aria-label="Primary"
      style={{
        flexShrink: 0,
        position: "relative",
        zIndex: 5,
        padding: "8px 18px 10px",
        // Extend the material under the home indicator: reclaim the shell's
        // safe-area padding and repaint it as our own background.
        paddingBottom: `calc(10px + ${SAFE_BOTTOM})`,
        marginBottom: `calc(-1 * ${SAFE_BOTTOM})`,
        background: "var(--mv3-bg)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-around",
          background: "var(--mv3-glass)",
          border: "1px solid var(--mv3-glass-border)",
          borderRadius: 28,
          padding: "9px 8px",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          boxShadow: "var(--mv3-glass-shadow)",
        }}
      >
        <TabItem tab={TABS[0]} pathname={pathname} />
        <TabItem tab={TABS[1]} pathname={pathname} />
        {/* Raised center + — capture. Routes to Create for now (the sheet
            conversion is a later phase). */}
        <button
          type="button"
          aria-label="Create"
          aria-current={createActive ? "page" : undefined}
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            navigate(routes.create);
          }}
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            lineHeight: 1,
            color: "#ffffff",
            boxShadow: "var(--mv3-plus-shadow)",
            marginTop: -18,
            border: "3px solid var(--mv3-bg)",
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
            padding: 0,
            flexShrink: 0,
          }}
        >
          +
        </button>
        <TabItem tab={TABS[2]} pathname={pathname} />
        <TabItem tab={TABS[3]} pathname={pathname} />
      </div>
    </nav>
  );
}
