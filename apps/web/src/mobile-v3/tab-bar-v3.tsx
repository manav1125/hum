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
 *   v9.3 makes the tap a NEW conversation, everywhere. See {@link MarkTab}.
 *
 * Everything else moved by frequency of use, not by importance:
 *   · Voice — a mode, not a place. Long-press ◉ here; a mic in the composer
 *     is the primary affordance (that half lives in the chat composer).
 *   · Your chats, then search and batch capture — ☰, top-left
 *     (`Mv3OverflowMenu`). The thread list leads it: the top-left control is
 *     what every other assistant opens its conversations from, and this build
 *     shipped without one.
 *   · People, conversations and Your Cue — the avatar, top-right, and that
 *     menu's `All of Your Cue` row is the ⓶ screen's door. It is NOT the
 *     mark's job any more, and it never depended on the mark.
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
  primaryDestination,
  tabLabel,
  type PrimaryDestination,
} from "@/components/nav/nav-model";
import { navigateToNewConversation } from "@/domains/chat/utils/conversation-navigation";
import { useSoftKeyboardOpen } from "@/hooks/use-soft-keyboard-open";

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
 * These are genuine full-canvas takeovers. A conversation is NOT one of them
 * any more.
 *
 * It used to be: `/conversations/` was on this list, so the bar vanished on
 * the surface you spend most of your day on. That is hidden-while-typing plus
 * hidden the rest of the time, and v25 · G3 #4 only asks for the first half —
 * *"returns on dismiss; it's navigation, and you're not navigating."* The cost
 * was not cosmetic. `/assistant` resolves into a conversation, so with the bar
 * gone there was no mark to press at home, and the mark is this phone's only
 * door to Your Cue. A whole destination was unreachable because a route
 * predicate was standing in for a question about the keyboard.
 */
function tabBarHidden(pathname: string): boolean {
  return (
    pathname.endsWith("/voice") ||
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
 * The centre mark — home tab, working-indicator and voice shortcut in one.
 *
 * Tap   → a NEW conversation, from every state including inside one.
 * Hold  → Voice. Voice stopped being a tab because it is a mode, not a
 *         place; this keeps it one gesture away from the thumb's home.
 *
 * ## Why the tap is "new", and how that squares with the design
 *
 * The owner, on a phone: *"the centre C doesn't point anywhere. It should go
 * to a new conversation."* Two earlier passes both answered a narrower
 * question than the one he was asking:
 *
 *   v9    hung a decorative `+` here whose tap at home was a navigation to
 *         the route you were already on — a no-op.
 *   v9.2  kept the destination and spent the at-home tap on the ⓶ screen.
 *         That removed the no-op but bought Your Cue a door it did not need
 *         and left the ROUTINE tap — the one from Today or Work — landing on
 *         whatever conversation you happened to leave open. Resuming a stale
 *         thread is the shape the owner reads as "doesn't point anywhere":
 *         the mark does something different on every press and none of it is
 *         the thing he wanted.
 *
 * Design's two lines reconcile exactly, and nothing has to be overruled:
 * *"the centre mark IS the home tab — real destination, real active state"*
 * (v22 §1) is about the SLOT — it still resolves a route, it still lights on
 * the conversation surface, `matchTalk` is unchanged. *"⌘N / Talk to Cue"* is
 * about the ACTION, and this is the phone's ⌘N. One destination, one gesture,
 * one outcome, from every state.
 *
 * It routes through {@link navigateToNewConversation} rather than a local
 * draft id so the phone's mark and desktop's ⌘N are provably the same action
 * — subagent panel reset, viewer back to chat, composer focused.
 *
 * ## What happened to the ⓶ door
 *
 * Nothing that depended on this. `Mv3OverflowMenu`'s ⓶ button (top-right,
 * every primary landing — HQ, Work and the chats index) carries an **All of
 * Your Cue** row that navigates to `routes.yourCue`, which on a phone renders
 * the ⓶ screen. That row predates this change and is unchanged by it;
 * `components/nav/your-cue-reachable.test.tsx` fails if it ever goes away.
 * The mark's at-home gesture was a SECOND path to one destination, i.e. the
 * duplication this navigation keeps removing — and a gesture is the worst of
 * the two paths to leave a whole destination standing on.
 *
 * The mark no longer lights on the ⓶ stack either. It used to, so the bar
 * would not render three dim tabs on Your Cue — but a lit tab is a claim that
 * pressing it brought you here and pressing it returns you, and from Your Cue
 * this one now starts a conversation instead. Your Cue is chrome-reached, not
 * tab-reached; "no tab selected" is the honest state, and a false one is
 * worse than a dim one.
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
  const active = destination.match(pathname);
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
      // One label, every state — because it is now one action in every state.
      // It names the destination design gave the slot AND what the press
      // does, so the mark cannot read as pointing at nothing.
      aria-label={`${destination.label} — new conversation (hold for voice)`}
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
        // A fresh thread, focused composer — the same call desktop's ⌘N
        // makes. It taps its own haptic, so this must not double it.
        navigateToNewConversation(navigate);
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
  const typing = useSoftKeyboardOpen();

  // Hidden while typing, present otherwise. `useSoftKeyboardOpen` fails open —
  // a viewport it cannot read reports no keyboard — because hiding somebody's
  // only door on a failure is the wrong direction to fail in.
  if (typing || tabBarHidden(pathname)) return null;

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
