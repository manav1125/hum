/**
 * Gravity — the shared visual system behind every sign-on screen.
 *
 * Design source: `docs/design/handoff-2026-08-02/06-signon/` (concept
 * "gravity"). The user's scattered tools spiral in from off-screen and lock
 * into two counter-rotating orbits around the Cue ring: chaos becomes a
 * system. The SAME system carries all four screens — it idles dimmed behind
 * the sign-in glass, a comet circles it while the link is in flight, and it
 * reverses into a hyperspace pull when a link is being redeemed. One physics,
 * four screens.
 *
 * Two build rules from the pack drive the implementation:
 *
 * 1. **Compositor only.** Every animation is `transform`/`opacity`. Blurred
 *    auroras are static textures that MOVE; the blur radius itself is never
 *    animated (that re-rasterises every frame).
 *
 * 2. **Nothing is communicated by motion alone.** The settled composition is
 *    the DEFAULT style and the animations only play it in — so
 *    `prefers-reduced-motion: reduce` can kill every animation with one rule
 *    and land on exactly the composed mid-state the pack specifies, rather
 *    than on an empty frame waiting for a keyframe that will never run.
 *
 * Keyframes live in a component-local <style> rather than `index.css` because
 * this whole surface is pre-router boot chrome that most sessions never
 * render; `mobile-v3/brief/brief-page.tsx` sets the same precedent.
 *
 * Colour: the pack's tokens, with two deliberate deviations, both because the
 * pack's value is a FILL value that fails 4.5:1 as small text:
 *   - accent text on ink uses #8FA9F2 (8.5:1), not #3D6EE8 (4.3:1)
 *   - the success tick on white uses #277E41 (4.6:1), not #2E8B57 (4.3:1)
 * Button labels on the #3D6EE8 fill are pure #FFF (4.57:1), not #F4F4F6
 * (4.16:1). Every state also carries a glyph — colour never carries a state
 * on its own.
 */
import type { ReactNode } from "react";

import { CueRing } from "@/mobile-v3/cue-ring";

/**
 * How the orbital system is behaving. Each screen names a posture; the system
 * itself owns what that looks like.
 */
export type GravityMode =
  /** S — chips fall in from off-screen, the ring draws, the dot pops. */
  | "falling"
  /** A / B / E — settled and breathing, dimmed behind a glass sheet. */
  | "idle"
  /** C — streaks converge inward; the ring sweeps shut and blooms. */
  | "converging"
  /** D1 — the comet burned out: the orbit decays to a dashed trace. */
  | "decayed"
  /** D2 — nothing found: an empty, motionless orbit. */
  | "empty"
  /** D3 — offline: the whole system holds still. Motion pausing IS the message. */
  | "frozen";

/** The four tools that fall into orbit, as glyphs (no icon font, no network). */
const CHIPS = [
  { glyph: "✉", label: "Mail" },
  { glyph: "▤", label: "Calendar" },
  { glyph: "◍", label: "Messages" },
  { glyph: "✓", label: "Tasks" },
] as const;

export const GRAVITY_KEYFRAMES = `
[data-gv]{
  --gv-bg:#0B0B0F; --gv-bg-deep:#030306; --gv-surface:#16161D;
  --gv-border:#2A2A35; --gv-text:#F4F4F6; --gv-muted:#9A9AA8;
  --gv-accent:#3D6EE8; --gv-accent-text:#8FA9F2; --gv-on-accent:#FFFFFF;
  --gv-error:#E5675B; --gv-ok:#5FD08A;
  /* M8's consent cards. --gv-body is card copy: a real muted-on-dark stop, NOT
     an opacity wrapper over --gv-text. Design's rule is that explanatory copy
     stays at full strength and receding happens by token, never by dimming the
     container. --gv-hold-text is the amber TEXT leg (the fill leg #B4770F fails
     as small copy on light); --gv-ok-fill is a ground under a white knob, so it
     takes the text stop of its hue on both themes. */
  --gv-body:#C9C9D4; --gv-hold-text:#E0A64B;
  --gv-ok-fill:#277E41; --gv-track:rgba(255,255,255,.14);
  --gv-glass:rgba(255,255,255,.045); --gv-glass-line:rgba(255,255,255,.10);
  --gv-aurora:rgba(61,110,232,.30);
  /* M7's bottom sheet. Opaque, not glass: the orbit passes BEHIND its top edge
     as it scales, and a translucent sheet would show the mark through the
     fields it is supposed to have made room for. */
  --gv-sheet:rgba(20,23,32,.98); --gv-grabber:rgba(255,255,255,.22);
  --gv-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --gv-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
}
[data-theme="light"] [data-gv], [data-gv][data-gv-theme="light"]{
  --gv-bg:#F6F6F8; --gv-bg-deep:#EDEDF1; --gv-surface:#FFFFFF;
  --gv-border:#E2E2E8; --gv-text:#17171C; --gv-muted:#6A6A76;
  --gv-accent:#3D6EE8; --gv-accent-text:#2B53C4; --gv-on-accent:#FFFFFF;
  --gv-error:#C4372B; --gv-ok:#277E41;
  --gv-body:#3A3A44; --gv-hold-text:#8A5A08;
  --gv-ok-fill:#277E41; --gv-track:rgba(23,23,28,.12);
  --gv-glass:rgba(23,23,28,.035); --gv-glass-line:rgba(23,23,28,.10);
  --gv-aurora:rgba(61,110,232,.18);
  --gv-sheet:#FFFFFF; --gv-grabber:rgba(23,23,28,.18);
}
@keyframes gvSpin{to{transform:rotate(360deg)}}
@keyframes gvSpinR{to{transform:rotate(-360deg)}}
@keyframes gvFall{0%{transform:translateX(330px) scale(.6);opacity:0}12%{opacity:1}55%,100%{transform:translateX(108px) scale(1);opacity:1}}
@keyframes gvFall2{0%{transform:translateX(360px) scale(.6);opacity:0}14%{opacity:.9}60%,100%{transform:translateX(150px) scale(1);opacity:.9}}
@keyframes gvDraw{0%,18%{stroke-dashoffset:707}62%,100%{stroke-dashoffset:0}}
@keyframes gvDot{0%,58%{opacity:0;transform:scale(0)}68%{opacity:1;transform:scale(1.6)}76%,100%{opacity:1;transform:scale(1)}}
@keyframes gvW1{0%,9%{opacity:0;transform:translateY(30px)}15%,22%{opacity:1;transform:translateY(0)}28%,100%{opacity:0;transform:translateY(-26px)}}
@keyframes gvW2{0%,31%{opacity:0;transform:translateY(30px)}37%,44%{opacity:1;transform:translateY(0)}50%,100%{opacity:0;transform:translateY(-26px)}}
@keyframes gvW3{0%,53%{opacity:0;transform:translateY(30px)}59%,66%{opacity:1;transform:translateY(0)}72%,100%{opacity:0;transform:translateY(-26px)}}
@keyframes gvW4{0%,75%{opacity:0;transform:translateY(30px)}83%,96%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-10px)}}
@keyframes gvFil{0%,55%{opacity:0}68%,86%{opacity:.6}100%{opacity:0}}
@keyframes gvRise{0%{opacity:0;transform:translateY(26px)}100%{opacity:1;transform:translateY(0)}}
@keyframes gvGlow{0%,100%{opacity:.45;transform:scale(1)}50%{opacity:1;transform:scale(1.22)}}
@keyframes gvAur{0%,100%{transform:translate(-10%,-5%) scale(1) rotate(0deg)}50%{transform:translate(8%,7%) scale(1.3) rotate(8deg)}}
@keyframes gvStreak{0%{transform:translateX(300px) scaleX(.3);opacity:0}10%{opacity:1}70%{transform:translateX(30px) scaleX(1.4);opacity:.9}100%{transform:translateX(-10px) scaleX(.2);opacity:0}}
@keyframes gvSweep{0%{stroke-dashoffset:200}70%,100%{stroke-dashoffset:0}}
@keyframes gvBloom{0%,70%{transform:scale(.9);opacity:0}78%{opacity:.65}100%{transform:scale(11);opacity:0}}
@keyframes gvSheen{0%{transform:translateX(-160%) skewX(-18deg)}55%,100%{transform:translateX(220%) skewX(-18deg)}}
@keyframes gvBreathScale{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}
@keyframes gvTwinkle{0%,100%{opacity:.1}50%{opacity:.8}}

/* Reduced motion: freeze to the composed mid-state. Every animated element's
   BASE style is already its settled state, so removing the animation lands on
   the pack's static frame instead of an unplayed keyframe's 0%. */
@media (prefers-reduced-motion: reduce){
  [data-gv] *, [data-gv]{ animation: none !important; transition: none !important; }
}
`;

/** Injects the Gravity keyframes + tokens once per mounted sign-on surface. */
export function GravityStyles() {
  return <style data-gv-styles>{GRAVITY_KEYFRAMES}</style>;
}

/** True when the user asked the OS for reduced motion. SSR/test-safe. */
export function prefersReducedMotion(): boolean {
  try {
    return (
      globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)")
        .matches === true
    );
  } catch {
    return false;
  }
}

function orbitAnimation(mode: GravityMode, reverse: boolean): string {
  // "empty" and "frozen" both hold still — D2 because there is nothing in
  // orbit to move, D3 because the stillness IS the offline message.
  if (mode === "empty" || mode === "frozen") return "none";
  const seconds = mode === "converging" ? 9 : mode === "falling" ? 22 : 30;
  return `${reverse ? "gvSpinR" : "gvSpin"} ${seconds}s linear infinite`;
}

/**
 * The orbital system itself: aurora, two counter-rotating orbits carrying the
 * tool chips, and the Cue mark at the centre of the gravity well.
 *
 * Rendered `aria-hidden` throughout — it is decoration. Every screen states
 * its meaning in text; nothing here is the only carrier of anything.
 */
export function OrbitalSystem({
  mode,
  size = 300,
  dim = false,
}: {
  mode: GravityMode;
  size?: number;
  /** A / B / E render the system dimmed behind the glass sheet. */
  dim?: boolean;
}) {
  const still = mode === "empty" || mode === "frozen";
  const falling = mode === "falling";
  const showChips = mode !== "empty";

  return (
    <div
      aria-hidden
      data-gv-system={mode}
      style={{
        position: "relative",
        width: size,
        height: size,
        opacity: dim ? 0.42 : 1,
        // "frozen" drains the colour: the system is still there, it just
        // isn't running. Paired with the ⦸ glyph on the screen itself.
        filter: mode === "frozen" ? "grayscale(1)" : undefined,
        transition: "opacity .4s ease",
        pointerEvents: "none",
        flexShrink: 0,
      }}
    >
      {/* Aurora — a static blurred texture that MOVES. Never an animated blur. */}
      <div
        style={{
          position: "absolute",
          inset: "-30%",
          background:
            "radial-gradient(46% 40% at 50% 50%, var(--gv-aurora), transparent 70%)",
          filter: "blur(34px)",
          animation: still ? "none" : "gvAur 13s ease-in-out infinite",
          willChange: "transform",
        }}
      />

      {/* Outer orbit */}
      <Orbit
        radius={size * 0.5}
        animation={orbitAnimation(mode, false)}
        dashed={mode === "decayed"}
      >
        {showChips
          ? CHIPS.slice(0, 2).map((chip, i) => (
              <Chip
                key={chip.label}
                chip={chip}
                offset={size * 0.36}
                falling={falling}
                fallKeyframe="gvFall"
                delay={i * 0.55}
                counterSpin={orbitAnimation(mode, true)}
              />
            ))
          : null}
      </Orbit>

      {/* Inner orbit, counter-rotating */}
      <Orbit
        radius={size * 0.34}
        animation={orbitAnimation(mode, true)}
        dashed={mode === "decayed"}
      >
        {showChips
          ? CHIPS.slice(2).map((chip, i) => (
              <Chip
                key={chip.label}
                chip={chip}
                offset={size * 0.24}
                falling={falling}
                fallKeyframe="gvFall2"
                delay={0.3 + i * 0.55}
                counterSpin={orbitAnimation(mode, false)}
              />
            ))
          : null}
      </Orbit>

      {/* Hyperspace streaks — only while connecting. */}
      {mode === "converging" ? (
        <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                top: `${14 + i * 13}%`,
                left: "50%",
                width: 90,
                height: 2,
                borderRadius: 2,
                background:
                  "linear-gradient(90deg, transparent, var(--gv-accent))",
                transformOrigin: "right center",
                animation: `gvStreak ${1.1 + (i % 3) * 0.22}s ease-in infinite`,
                animationDelay: `${i * 0.13}s`,
                willChange: "transform, opacity",
              }}
            />
          ))}
        </div>
      ) : null}

      {/* The core: the true Cue mark. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: size * 0.44,
            height: size * 0.44,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, var(--gv-aurora), transparent 70%)",
            animation: still ? "none" : "gvGlow 4.5s ease-in-out infinite",
          }}
        />
        {falling ? (
          <DrawingRing size={size * 0.34} />
        ) : (
          <CueRing
            size={size * 0.34}
            stroke="var(--gv-text)"
            style={
              still
                ? undefined
                : { animation: "gvBreathScale 6s ease-in-out infinite" }
            }
          />
        )}
        {mode === "converging" ? <SweepRing size={size * 0.52} /> : null}
      </div>

      {mode === "converging" ? (
        <div
          style={{
            position: "absolute",
            inset: "35%",
            borderRadius: "50%",
            border: "2px solid var(--gv-accent)",
            animation: "gvBloom 2.4s ease-in infinite",
            willChange: "transform, opacity",
          }}
        />
      ) : null}
    </div>
  );
}

/** One orbit ring plus the children riding it. */
function Orbit({
  radius,
  animation,
  dashed,
  children,
}: {
  radius: number;
  animation: string;
  dashed: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: radius * 2,
          height: radius * 2,
          borderRadius: "50%",
          border: `1px ${dashed ? "dashed" : "solid"} var(--gv-border)`,
          opacity: dashed ? 0.55 : 0.8,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: radius * 2,
          height: radius * 2,
          animation,
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** One tool chip locked into orbit. */
function Chip({
  chip,
  offset,
  falling,
  fallKeyframe,
  delay,
  counterSpin,
}: {
  chip: (typeof CHIPS)[number];
  offset: number;
  falling: boolean;
  fallKeyframe: string;
  delay: number;
  /** Keeps the glyph upright while its orbit rotates underneath it. */
  counterSpin: string;
}) {
  return (
    <span
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        marginTop: -16,
        marginLeft: -16,
        width: 32,
        height: 32,
        // Settled position IS the base style, so reduced motion lands here.
        transform: `translateX(${offset}px)`,
        animation: falling
          ? `${fallKeyframe} 9s cubic-bezier(.2,.7,.2,1) ${delay}s both`
          : undefined,
        willChange: "transform, opacity",
      }}
    >
      <span
        style={{
          display: "flex",
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 10,
          background: "var(--gv-surface)",
          border: "1px solid var(--gv-border)",
          color: "var(--gv-text)",
          fontSize: 15,
          lineHeight: 1,
          animation: counterSpin === "none" ? undefined : counterSpin,
        }}
      >
        {chip.glyph}
      </span>
    </span>
  );
}

/** The splash's self-drawing Cue mark (dasharray 707/236, rotate 42°). */
function DrawingRing({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <circle
        cx="232"
        cy="256"
        r="150"
        fill="none"
        stroke="var(--gv-text)"
        strokeWidth="42"
        strokeLinecap="round"
        strokeDasharray="707 236"
        transform="rotate(42 232 256)"
        style={{
          strokeDashoffset: 0,
          animation: "gvDraw 9s cubic-bezier(.4,0,.2,1) both",
        }}
      />
      <circle
        cx="392"
        cy="372"
        r="32"
        fill="#3D6EE8"
        style={{
          transformOrigin: "392px 372px",
          animation: "gvDot 9s cubic-bezier(.3,1.4,.4,1) both",
        }}
      />
    </svg>
  );
}

/** The determinate progress ring that sweeps shut around the mark on C. */
function SweepRing({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden
      style={{ position: "absolute", transform: "rotate(-90deg)" }}
    >
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        stroke="var(--gv-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="290"
        style={{ strokeDashoffset: 0, animation: "gvSweep 2.4s ease-out both" }}
      />
    </svg>
  );
}
