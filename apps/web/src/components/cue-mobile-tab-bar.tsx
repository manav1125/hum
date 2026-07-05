/**
 * Cue mobile tab bar.
 *
 * On mobile the three-column desktop layout collapses, so primary navigation
 * moves to a persistent bottom tab bar, built to the mobile design book's
 * shared system (`design_handoff_mobile_surfaces`, "Shared System > Bottom tab
 * bar"): `Today · Projects · ✳ (center, raised) · Voice · You`.
 *   - Today    → the HQ surface (`/hq`) — the one landing surface ("Home grew
 *                up", Cue-HQ-Build §1). The label stays "Today" (the word that
 *                owns the first tab) with the rings glyph; the surface adapts
 *                (pulse with zero missions, rings deck otherwise). The old
 *                `/home`, `/mission-control`, `/activity`, `/agents`,
 *                `/next-moves` all redirect to `/hq`, so Today highlights for
 *                every one of them.
 *   - Projects → the cowork surface (`/projects`): work grouped under briefs
 *                Cue reads before running each task. A primary destination.
 *   - ✳        → the "what do you want to get done?" capture / Create picker
 *                (`/create`), presented as a RAISED accent capture button (not
 *                a flat third tab): a 46×46 rounded-square filled accent blue,
 *                white ✳ glyph, offset up ~14px with a drop shadow.
 *   - Voice    → the full-bleed Voice mode screen (owns the live-voice session).
 *   - You      → identity hub (Channels / Memory / Settings), entered at
 *                Channels — a 20px gradient avatar circle bearing the user's
 *                initial, with a 2px accent outline when active.
 * Chat is no longer a tab — it is a full-screen push reached by opening a
 * next-move card or a task. Rendered only at the mobile breakpoint, as a
 * flex-shrink-0 footer inside the root layout (so it sits above the safe-area
 * inset the shell pads).
 *
 * VISIBILITY: the design hides the tab bar on the full-screen surfaces that
 * carry their own bottom dock instead — Voice (full-screen takeover) and the
 * chat/conversation screen (its own sticky composer dock). This component
 * returns `null` on those routes so those surfaces render edge-to-edge; every
 * other surface (Today / Projects / Create / People / Library) keeps the bar.
 * This gating lives here (already mobile-only) so desktop is untouched.
 */

import { FolderKanban, Mic } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/** The Today "rings" glyph (◎) — concentric status rings, per the HQ deck. */
function RingsGlyph({ size = 19 }: { size?: number }) {
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

/** The ✳ capture glyph (asterism / sparkle) drawn as strokes so it inherits
 *  `currentColor` (white on the accent tile). */
function CaptureGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" />
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
    icon: <RingsGlyph size={19} />,
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
    icon: <FolderKanban size={19} strokeWidth={2} />,
    match: (p) => p.includes("/projects") || p.endsWith("/work"),
  },
  {
    key: "voice",
    label: "Voice",
    to: routes.voice,
    icon: <Mic size={20} strokeWidth={2} />,
    match: (p) => p.endsWith("/voice"),
  },
];

/** Pathnames that own their own bottom dock, so the tab bar hides on them:
 *  the Voice full-screen takeover and the chat/conversation screen (sticky
 *  composer dock). */
function tabBarHidden(pathname: string): boolean {
  return pathname.endsWith("/voice") || pathname.includes("/conversations");
}

/** First initial for the "You" avatar — the user's first name / username /
 *  email, falling back to "M" (the design-book default monogram). Uppercased. */
function userInitial(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  const first = trimmed.charAt(0);
  return first ? first.toUpperCase() : "M";
}

export function CueMobileTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const user = useAuthStore.use.user();

  // Voice + chat carry their own bottom dock — the design hides the shared
  // tab bar there so those surfaces render edge-to-edge.
  if (tabBarHidden(pathname)) return null;

  const initial = userInitial(user?.firstName || user?.username || user?.email);

  const createActive = pathname.endsWith("/create");
  const youActive =
    pathname.includes("/channels") ||
    pathname.includes("/memory") ||
    pathname.includes("/settings") ||
    pathname.startsWith(routes.contacts.root);

  return (
    <nav
      data-slot="cue-mobile-tab-bar"
      aria-label="Primary"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-between",
        gap: 2,
        // Extra headroom so the raised ✳ capture button can lift out of the
        // bar without clipping.
        paddingTop: 9,
        paddingBottom: 4,
        paddingLeft: 8,
        paddingRight: 8,
        // Dark bar material `rgba(15,18,24,.92)` blur 20 (theme-aware via the
        // `--mv1-*` veil, which resolves light under the light theme).
        background: "var(--mv1-composer-veil)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid var(--mv1-line)",
      }}
    >
      {/* Today */}
      <TabButton
        label={TABS[0].label}
        icon={TABS[0].icon}
        active={TABS[0].match(pathname)}
        onClick={() => navigate(TABS[0].to)}
      />
      {/* Projects */}
      <TabButton
        label={TABS[1].label}
        icon={TABS[1].icon}
        active={TABS[1].match(pathname)}
        onClick={() => navigate(TABS[1].to)}
      />
      {/* ✳ — raised capture button (Create). */}
      <CaptureButton
        active={createActive}
        onClick={() => navigate(routes.create)}
      />
      {/* Voice */}
      <TabButton
        label={TABS[2].label}
        icon={TABS[2].icon}
        active={TABS[2].match(pathname)}
        onClick={() => navigate(TABS[2].to)}
      />
      {/* You — gradient avatar with the user's initial. */}
      <YouButton
        initial={initial}
        active={youActive}
        onClick={() => navigate(routes.channels)}
      />
    </nav>
  );
}

const ACCENT = "var(--accent-cue, #3d6ee8)";
const ACCENT_STRONG = "var(--mv1-blue-strong, #2b53c4)";
const TERTIARY = "var(--mv1-t3, var(--content-tertiary))";

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
        justifyContent: "flex-start",
        gap: 4,
        border: "none",
        background: "transparent",
        color: active ? ACCENT : TERTIARY,
        opacity: busy ? 0.6 : 1,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        transition: "color .15s ease, opacity .15s ease",
      }}
    >
      <span style={{ display: "flex" }}>{icon}</span>
      <span
        style={{
          fontSize: 10,
          fontWeight: active ? 600 : 500,
          letterSpacing: "0.01em",
        }}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * The center ✳ capture button — a raised 46×46 rounded-square (radius 15)
 * filled accent blue with a white glyph, lifted ~14px above the bar with a
 * drop shadow. Tapping navigates to Create (destination unchanged).
 */
function CaptureButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label="Create"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        padding: 0,
      }}
    >
      <span
        style={{
          width: 46,
          height: 46,
          borderRadius: 15,
          // Lift the tile up out of the bar.
          marginTop: -14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `linear-gradient(155deg, #5B86F0, ${ACCENT})`,
          color: "#ffffff",
          boxShadow: active
            ? "0 10px 22px -8px rgba(43,83,196,.85), 0 0 0 3px var(--mv1-blue-wash, rgba(61,110,232,.18))"
            : "0 10px 22px -8px rgba(43,83,196,.7)",
          transition: "box-shadow .15s ease, transform .15s ease",
        }}
      >
        <CaptureGlyph size={22} />
      </span>
    </button>
  );
}

/**
 * The "You" tab — a 20px gradient avatar circle bearing the user's initial,
 * with a 2px accent outline when active. Replaces the plain person glyph.
 */
function YouButton({
  initial,
  active,
  onClick,
}: {
  initial: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label="You"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: 4,
        border: "none",
        background: "transparent",
        color: active ? ACCENT : TERTIARY,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        transition: "color .15s ease",
      }}
    >
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `linear-gradient(155deg, #5B86F0, ${ACCENT_STRONG})`,
          color: "#ffffff",
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          // 2px blue outline when active (drawn as a ring so it doesn't shift
          // layout).
          boxShadow: active ? `0 0 0 2px ${ACCENT}` : "none",
          transition: "box-shadow .15s ease",
        }}
      >
        {initial}
      </span>
      <span
        style={{
          fontSize: 10,
          fontWeight: active ? 600 : 500,
          letterSpacing: "0.01em",
        }}
      >
        You
      </span>
    </button>
  );
}
