/**
 * C · Connecting — "the pull, then the bloom".
 *
 * Plays only on the page load that consumed a `?cueToken=` magic link: light
 * streaks converge on the Cue mark, a determinate ring sweeps shut, and the
 * provisioning lines speak in sequence (Verifying ✓ → Waking your agents →
 * Picking up where you left off) so a slow connect still feels like things
 * happening for you. At the end a bloom expands past the bezel — the
 * crossfade into the app.
 *
 * SAFETY: this is an OVERLAY, never a gate. The real app boots underneath it
 * on exactly the schedule it always did; this only sits on top for a fixed
 * duration and then removes itself. If anything in here throws or a timer
 * never lands, the user still ends up in a signed-in app — a decorative
 * screen must not be able to stand between someone and their session. It also
 * unmounts on click and on Escape, so it can always be dismissed by hand.
 */
import { useEffect, useState } from "react";

import { didSeedFromMagicLink } from "@/lib/self-hosted/cue-self-host";

import {
  GravityStyles,
  OrbitalSystem,
  prefersReducedMotion,
} from "./gravity-kit";

/** Total time the overlay is allowed to hold the screen. */
const DURATION_MS = 2400;
/** Reduced motion collapses the sweep to a plain crossfade. */
const REDUCED_DURATION_MS = 600;

const LINES = [
  { glyph: "✓", text: "Verifying your link" },
  { glyph: "◱", text: "Waking your agents" },
  { glyph: "↴", text: "Picking up where you left off" },
] as const;

export function ConnectingOverlay() {
  // Read once, at mount: the flag describes THIS page load, and re-reading it
  // after a state change must not resurrect a dismissed overlay.
  const [armed] = useState(() => {
    try {
      return didSeedFromMagicLink();
    } catch {
      return false;
    }
  });
  const [visible, setVisible] = useState(armed);
  const [reduced] = useState(prefersReducedMotion);
  // Which provisioning line is currently speaking. Driven in JS rather than by
  // keyframes so the finished lines STAY on screen: a CSS sequence with
  // `fill-mode: both` ends at its last keyframe, which for a cycling animation
  // is invisible — the exact "communicated by motion alone" trap the pack bans.
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const ms = reduced ? REDUCED_DURATION_MS : DURATION_MS;
    const step = setInterval(
      () => setActive((n) => Math.min(n + 1, LINES.length - 1)),
      Math.max(1, Math.floor(ms / LINES.length)),
    );
    const timer = setTimeout(() => setVisible(false), ms);
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVisible(false);
    };
    globalThis.window?.addEventListener("keydown", dismiss);
    return () => {
      clearTimeout(timer);
      clearInterval(step);
      globalThis.window?.removeEventListener("keydown", dismiss);
    };
  }, [visible, reduced]);

  if (!visible) return null;

  return (
    <div
      data-gv
      data-signon-connecting
      role="status"
      aria-live="polite"
      onClick={() => setVisible(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 26,
        background: "var(--gv-bg)",
        color: "var(--gv-text)",
        fontFamily: "var(--gv-font)",
        animation: "gvRise .3s ease both",
      }}
    >
      <GravityStyles />
      <OrbitalSystem mode={reduced ? "idle" : "converging"} size={250} />
      <h1
        style={{
          margin: 0,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-.02em",
        }}
      >
        Opening your Cue…
      </h1>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 9,
          fontSize: 13.5,
          color: "var(--gv-muted)",
        }}
      >
        {LINES.map((line, i) => {
          const done = i < active;
          return (
            <li
              key={line.text}
              style={{
                display: "flex",
                gap: 9,
                alignItems: "center",
                // Every line is legible from the first frame — the sequence
                // only says which one is speaking now.
                color: i === active ? "var(--gv-text)" : "var(--gv-muted)",
              }}
            >
              <span aria-hidden style={{ color: "var(--gv-accent-text)" }}>
                {done ? "✓" : line.glyph}
              </span>
              <span>{line.text}</span>
            </li>
          );
        })}
      </ul>
      <p style={{ margin: 0, fontSize: 12, color: "var(--gv-muted)" }}>
        Tap anywhere to skip
      </p>
    </div>
  );
}
