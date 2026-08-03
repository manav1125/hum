/**
 * TabBarV3 — the phone's primary navigation: `◈ Today · ◉ · ▤ Work`.
 *
 * **Three is the ceiling and it is full.** v22 shipped a fourth slot (People);
 * v23 took it back, and the argument was about the mark rather than about
 * counting: *"with four slots the mark sits at position 2 of 4 — off-centre,
 * which reads as an accident. The raised centre button only works when it IS
 * the centre."* People moved to the ⓶ surfaces plus contextual entry from
 * every name in the app; Library became Work's third view. A new destination
 * displaces one or becomes a view inside an existing tab. Never a fourth tab.
 *
 * Three slots, down from five (`Today · Projects · + · Voice · You`). The cut
 * took three passes and the reasoning is the load-bearing part:
 *
 *   v8   dropped the centre `+`. Right reason — the composer IS the plus —
 *        but it priced the muscle memory of that slot at zero.
 *   v9   restored it as a floating mark. Wrong reason: asked "what does the
 *        C point to?", the answer was nothing. A no-op on home, a duplicate
 *        of the home tab everywhere else.
 *   v9.2 centres the mark and makes it THE HOME TAB. A real destination with
 *        a real active state, the fastest route back to talking, and it
 *        pulses while agents are working. One element doing three jobs
 *        instead of one doing none.
 *
 * Everything else moved by frequency of use, not by importance:
 *   · Voice — a mode, not a place. Long-press ◉ here; a mic in the composer
 *     is the primary affordance (that half lives in the chat composer).
 *   · Search and batch capture — ☰, top-left (`Mv3OverflowMenu`).
 *   · People, conversations and Your Cue — the avatar, top-right.
 *   · Config — the ⓶ screen, one press of the mark from home.
 * Two of the old five slots went to things touched weekly or less, which is
 * precisely what was squeezing the actual work.
 *
 * Today carries the only badge in the app.
 *
 * The three destinations come from `@/components/nav/nav-model`, shared with
 * the desktop sidebar — v11's finding was that the two platforms had quietly
 * started describing different information models, which is worse than either
 * being wrong alone.
 *
 * Spec values retained: pill bg rgba(22,26,36,.82)/rgba(255,255,255,.85),
 * hairline border, radius 28, padding 9px 8px, blur(24px), shadow
 * 0 18px 40px -18px; items min-width 56, icon 21–22, label 9.5px (active =
 * microlabel color, weight 600; inactive dimmed).
 *
 * Safe area: the wrapper extends the bar's material UNDER the home indicator.
 * The root layout pads the shell by the bottom inset, so the wrapper claws
 * that padding back with a negative margin and re-pads itself, painting
 * `--mv3-bg` down to the physical bottom edge.
 */
import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  MOBILE_TAB_ORDER,
  YOUR_CUE_DOOR,
  primaryDestination,
  tabLabel,
  type PrimaryDestination,
} from "@/components/nav/nav-model";
import { useNavCounts } from "@/components/nav/use-nav-counts";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";
import { useNeedsYouBadge } from "@/hooks/use-needs-you-badge";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { CueRing } from "./cue-ring";

const SAFE_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";

/** How long a press on ◉ must hold before it opens Voice instead of chat. */
const LONG_PRESS_MS = 450;

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

/** ◈ HQ — the deck that empties. */
function HqGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <path d="M12 3.2 20.2 12 12 20.8 3.8 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

/** ▤ Work — the list of things that never empties. */
function WorkGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="4" />
      <path d="M3 9.5h18M8.5 9.5V20" />
    </svg>
  );
}

/**
 * Surfaces that own their own bottom dock — the bar hides there so those
 * screens keep rendering edge-to-edge.
 *
 * A conversation (with id) owns its composer dock; the bare chats index
 * (/assistant/conversations) keeps the bar so the list stays inside the
 * primary nav. The Morning Brief is a full-canvas takeover; the pre-app
 * onboarding flow owns its full canvas too.
 */
function tabBarHidden(pathname: string): boolean {
  return (
    pathname.endsWith("/voice") ||
    pathname.includes("/conversations/") ||
    pathname.endsWith("/brief") ||
    pathname.includes("/onboarding/")
  );
}

function TabItem({
  destination,
  pathname,
  badgeCount = 0,
  children,
}: {
  destination: PrimaryDestination;
  pathname: string;
  /** Items waiting on the user; renders a count dot. 0 renders nothing. */
  badgeCount?: number;
  children: (active: boolean) => React.ReactNode;
}) {
  const navigate = useNavigate();
  const active = destination.match(pathname);
  return (
    <button
      type="button"
      onClick={() => {
        haptic.light();
        navigate(destination.to);
      }}
      aria-label={destination.label}
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
      <span style={{ position: "relative", display: "inline-flex" }}>
        {children(active)}
        {badgeCount > 0 ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -3,
              right: -8,
              minWidth: 15,
              height: 15,
              padding: "0 4px",
              borderRadius: 8,
              background: "var(--mv3-accent-on-fill)",
              color: "#fff",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: "15px",
              textAlign: "center",
            }}
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        ) : null}
      </span>
      <span
        style={{
          fontSize: 9.5,
          fontWeight: active ? 600 : 400,
          color: active ? "var(--mv3-micro)" : "var(--mv3-text)",
        }}
      >
        {tabLabel(destination)}
      </span>
    </button>
  );
}

/**
 * The centre mark — home tab, working-indicator, config door and voice
 * shortcut in one.
 *
 * Tap          → the conversation surface (`/assistant` resumes the last
 *                thread).
 * Tap at home  → the ⓶ screen (v24 F2): what Cue is doing, and how it is set
 *                up. This is the brief's *"You / config → the ⓶ screen (press
 *                the mark when already home)"*, and it is what pays for the
 *                third tab slot the config door no longer occupies.
 * Hold         → Voice. Voice stopped being a tab because it is a mode, not a
 *                place; this keeps it one gesture away from the thumb's home.
 *
 * A tap at home used to be a no-op — a navigation to the route you were
 * already on. That is the shape design rejected in v9: *"asked 'what does the
 * C point to?', the answer was nothing."*
 *
 * `pulsing` is driven by real running work items — never by "something might
 * be happening". A pulse that lies is worse than no pulse.
 */
function MarkTab({
  pathname,
  pulsing,
}: {
  pathname: string;
  pulsing: boolean;
}) {
  const navigate = useNavigate();
  const destination = primaryDestination("talk");
  const atHome = destination.match(pathname);
  // The mark stays lit across the whole ⓶ stack — the screen it opens and
  // every leaf pushed from it. Without this the bar renders three dim tabs on
  // Your Cue, which is the "nothing is selected" state the phone shipped for
  // days on a different surface.
  const inCueStack = YOUR_CUE_DOOR.match(pathname);
  const active = atHome || inCueStack;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedLongPress = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPressStart = useCallback(() => {
    firedLongPress.current = false;
    clear();
    timer.current = setTimeout(() => {
      firedLongPress.current = true;
      haptic.medium();
      navigate(routes.voice);
    }, LONG_PRESS_MS);
  }, [clear, navigate]);

  return (
    <button
      type="button"
      aria-label={
        atHome
          ? "Your Cue — what Cue is doing and how it's set up (hold for voice)"
          : `${destination.label} (hold for voice)`
      }
      aria-current={active ? "page" : undefined}
      className="cue-pressable"
      onPointerDown={onPressStart}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onClick={() => {
        // The long-press already navigated; the trailing click must not
        // bounce the user straight back out of Voice.
        if (firedLongPress.current) {
          firedLongPress.current = false;
          return;
        }
        haptic.light();
        // Already home → the ⓶ screen. Anywhere else → home.
        navigate(active ? routes.yourCue : destination.to);
      }}
      style={{
        // Raised, filled, and 46px across — the treatment every frame in v22,
        // v23 and v24 draws. The mark is not a tab that happens to be in the
        // middle; it is the brand, and the raised centre is the only thing
        // that makes three slots read as deliberate rather than arbitrary.
        position: "relative",
        width: 46,
        height: 46,
        flexShrink: 0,
        marginTop: -14,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        color: "var(--mv3-text)",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Working halo. Present only while something actually runs, and it
            carries its own accessible name so the state is never colour- or
            motion-only. */}
        {pulsing ? (
          <>
            <span
              aria-hidden
              style={{
                position: "absolute",
                inset: -7,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, color-mix(in srgb, var(--mv3-accent) 45%, transparent) 0%, transparent 70%)",
                animation: "mv3Glow 2.4s ease-in-out infinite",
                pointerEvents: "none",
              }}
            />
            <span
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clipPath: "inset(50%)",
                whiteSpace: "nowrap",
              }}
            >
              Agents are working
            </span>
          </>
        ) : null}
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            // `-on-fill` is the ground under white marks. The bright accent
            // leg belongs to strokes and rings, never under white.
            background: "var(--mv3-accent-on-fill)",
            // The ring of background separating the raised mark from the pill
            // beneath it — the frames draw 3px of the screen colour.
            border: "3px solid var(--mv3-bg)",
            boxShadow: "var(--mv3-plus-shadow)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            animation: pulsing
              ? "mv3Breathe 2.4s ease-in-out infinite"
              : undefined,
          }}
        >
          <CueRing size={23} stroke="#fff" strokeWidth={48} dotRadius={36} />
        </span>
      </span>
      {/* The frames give the mark no printed label — it is the brand, raised
          and filled, which is the iOS convention for a centre action. The name
          is still announced, and the tab-bar test still reads it, so this is a
          typographic decision rather than a missing affordance. */}
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
          whiteSpace: "nowrap",
        }}
      >
        {tabLabel(destination)}
      </span>
    </button>
  );
}

export function TabBarV3() {
  const { pathname } = useLocation();
  // Read the raw store, not useActiveAssistantId(): the tab bar mounts from the
  // root layout (including pre-assistant screens), where that hook throws.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { count: needsYouCount } = useNeedsYouBadge(assistantId ?? null);
  const { agentsWorking } = useNavCounts(assistantId ?? null);

  if (tabBarHidden(pathname)) return null;

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
        {MOBILE_TAB_ORDER.map((key) => {
          if (key === "talk") {
            return (
              <MarkTab key={key} pathname={pathname} pulsing={agentsWorking} />
            );
          }
          const destination = primaryDestination(key);
          return (
            <TabItem
              key={key}
              destination={destination}
              pathname={pathname}
              // HQ carries the only badge in the app.
              badgeCount={key === "hq" ? needsYouCount : 0}
            >
              {() => (key === "hq" ? <HqGlyph /> : <WorkGlyph />)}
            </TabItem>
          );
        })}
      </div>
    </nav>
  );
}
