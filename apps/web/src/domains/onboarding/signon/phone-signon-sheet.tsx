/**
 * M7 — the phone shell the sign-on screens sit in.
 *
 * This does NOT rebuild the sign-on arc. The arc shipped and is live; every
 * screen inside it (A sign in · B check email · E address · D1/D2/D3) is
 * unchanged and still renders exactly the same children. All that changes at
 * phone width is the container: the desktop's centred glass card becomes a
 * bottom sheet, and the orbital system moves from behind the card to the strip
 * above it, where it scales as the sheet rises.
 *
 * Gated on POINTER TYPE, not width — design's own rule ("these frames assume
 * coarse pointer"), and the same lesson `useMobileLayout` learned the hard way
 * when a 440px Electron onboarding window silently took the phone branch.
 *
 * Reach: the sheet's primary sits at ~63% of viewport height at the resting
 * detent, inside the bottom-third rule. Escape: the whole sheet carries
 * swipe-back, so no screen depends on a top-corner control.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { KEYBOARD_CURVE } from "@/mobile-v3/chats/phone-keyboard";
import { useSwipeBack } from "@/mobile-v3/states/swipe-back";
import { useVisibleViewport } from "@/hooks/use-visible-viewport";

import { OrbitalSystem, type GravityMode } from "./gravity-kit";
import { resolveSignonSheet, type SignonSheet } from "./signon-phone";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribeCoarse(onChange: () => void): () => void {
  const mql = globalThis.window?.matchMedia?.(COARSE_POINTER_QUERY);
  if (!mql) return () => undefined;
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function readCoarse(): boolean {
  return (
    globalThis.window?.matchMedia?.(COARSE_POINTER_QUERY).matches === true
  );
}

/**
 * True on a touch-first device. Not a width test: a narrow desktop window is
 * still a desktop, and a tablet in a wide split is still a finger.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarse, readCoarse, () => false);
}

/**
 * The live M7 geometry. The layout viewport is reconstructed by adding the
 * keyboard back on: under WKWebView the frame itself shrinks, so
 * `window.innerHeight` alone would report the visible strip and the detents
 * would be taken against the wrong ruler.
 */
export function useSignonSheet(): SignonSheet {
  const viewport = useVisibleViewport();
  const [fallbackHeight, setFallbackHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  useEffect(() => {
    const onResize = () => setFallbackHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const keyboardHeight = viewport?.keyboardHeight ?? 0;
  const viewportHeight = viewport
    ? viewport.height + keyboardHeight
    : fallbackHeight;

  return resolveSignonSheet({ viewportHeight, keyboardHeight });
}

/**
 * The sheet itself.
 *
 * `onBack` is the screen's own back path — `null` on screens that have none
 * (the first sign-in screen), so the gesture is attached only where it means
 * something rather than silently eating a swipe.
 */
export function PhoneSignonSheet({
  mode,
  onBack,
  children,
}: {
  mode: GravityMode;
  onBack?: (() => void) | null;
  children: React.ReactNode;
}) {
  const frame = useSignonSheet();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useSwipeBack(sheetRef, onBack ?? null);

  return (
    <div
      data-signon-phone
      data-keyboard={frame.keyboardOpen ? "open" : "down"}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* The brand strip. `flex: 1` so it IS whatever the sheet leaves, and
          `min-height: 0` so it can actually give that space up — without it a
          flex child refuses to shrink below its content and the mark would be
          pushed under the sheet, which is the crop design ruled out. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingTop:
            "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          paddingBottom: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: frame.orbitSize,
            height: frame.orbitSize,
            flexShrink: 0,
            transition: `width ${KEYBOARD_CURVE}, height ${KEYBOARD_CURVE}`,
          }}
        >
          {/* The system draws at full size and is scaled down, so the stroke
              weights stay in proportion; the wrapper above carries the smaller
              LAYOUT box, which is what keeps it out from under the sheet. */}
          <div
            style={{
              width: 230,
              height: 230,
              transformOrigin: "top left",
              transform: `scale(${frame.orbitScale})`,
              transition: `transform ${KEYBOARD_CURVE}`,
              willChange: "transform",
            }}
          >
            <OrbitalSystem mode={mode} size={230} />
          </div>
        </div>

        {/* The wordmark's BOX collapses, not just its opacity. A block at
            `opacity: 0` still occupies its height, and in an 84px strip that
            height is what shoves the mark up under `overflow: hidden` — which
            is a crop, arrived at by a different route. */}
        <div
          aria-hidden={frame.wordmarkOpacity === 0}
          style={{
            flexShrink: 0,
            overflow: "hidden",
            maxHeight: frame.wordmarkOpacity > 0 ? 64 : 0,
            marginTop: frame.wordmarkOpacity > 0 ? 12 : 0,
            textAlign: "center",
            opacity: frame.wordmarkOpacity,
            transition: `opacity ${KEYBOARD_CURVE}, max-height ${KEYBOARD_CURVE}, margin-top ${KEYBOARD_CURVE}`,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontSize: 19,
              fontWeight: 700,
              letterSpacing: "-.4px",
              color: "var(--gv-text)",
            }}
          >
            Welcome to Cue
          </div>
          <div
            style={{ fontSize: 11.5, color: "var(--gv-muted)", marginTop: 4 }}
          >
            Your personal &amp; professional AI
          </div>
        </div>
      </div>

      <div
        ref={sheetRef}
        role="group"
        aria-label="Sign in"
        style={{
          height: frame.sheetHeight,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRadius: "26px 26px 0 0",
          borderTop: "1px solid var(--gv-glass-line)",
          background: "var(--gv-sheet, var(--gv-surface))",
          boxShadow: "0 -20px 50px -20px rgba(0,0,0,.6)",
          transition: `height ${KEYBOARD_CURVE}`,
          willChange: "height",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 38,
            height: 5,
            borderRadius: 99,
            background: "var(--gv-grabber, rgba(255,255,255,.22))",
            margin: "10px auto 4px",
            flexShrink: 0,
          }}
        />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "8px 18px 0",
            // The keys overlap the sheet's lower edge; this is the padding that
            // keeps the last control off them. `env()` alone would be the home
            // indicator, which is behind the keyboard while it is up.
            paddingBottom: frame.keyboardOpen
              ? frame.sheetBottomInset + 16
              : "calc(18px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            transition: `padding-bottom ${KEYBOARD_CURVE}`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
