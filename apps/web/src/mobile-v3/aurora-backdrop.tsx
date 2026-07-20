/**
 * AuroraBackdrop — the drifting aurora every mv3 screen sits on.
 *
 * Spec (frame 1/12): an `inset: -20%` layer carrying a radial gradient
 * (`44% 30% at 50% 4%`, accent-blue → transparent 68%) under a 30px blur,
 * drifting on the 12s `mv3Aur` ease-in-out loop.
 *
 * PERF GUARDRAIL (WKWebView): the blur is applied ONCE as a static filter on
 * a static gradient texture; only `transform` animates (translate/scale in
 * `mv3Aur`) — the browser rasterizes the blurred layer a single time and the
 * animation is pure compositing. Never animate `filter`/`backdrop-filter`
 * here. `prefers-reduced-motion` freezes the drift via the shared
 * `[data-mv3]` rule in mv3.css.
 *
 * Render it as the first child of a `position: relative; overflow: hidden`
 * screen container.
 *
 * OVERFLOW GUARDRAIL: the gradient layer's `inset: -20%` makes it wider than
 * the screen (546px on a 390px viewport). Absolutely-positioned overhang past
 * the container's right edge still counts as *scrollable* overflow under
 * `overflow: hidden` — programmatic scrolls (input focus, streaming
 * autoscroll) could drift the page shell's `scrollLeft` sideways and stick,
 * clipping headers/composers. The gradient therefore renders inside a
 * full-inset `overflow: clip; contain: strict` wrapper so the overhang can
 * never create scrollable overflow on any page shell. (Visually identical:
 * the shells clipped the overhang at their bounds anyway.)
 */
import { useMv3EntranceGuard } from "./entrance-guard";

export function AuroraBackdrop({
  style,
}: {
  style?: React.CSSProperties;
} = {}) {
  // Every mv3 screen renders this backdrop, so it doubles as the mount point
  // for the entrance guard (stuck play-pending entrances → snap visible).
  useMv3EntranceGuard();
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        overflow: "clip",
        // Size/layout/paint containment: the oversized child can neither
        // paint outside this box nor contribute scrollable overflow.
        contain: "strict",
        pointerEvents: "none",
      }}
    >
      <div
        data-mv3
        style={{
          position: "absolute",
          inset: "-20%",
          background:
            "radial-gradient(44% 30% at 50% 4%, var(--mv3-aurora), transparent 68%)",
          filter: "blur(30px)",
          animation: "mv3Aur 12s ease-in-out infinite",
          // Own layer so the one-time blur rasterization is reused across the
          // transform animation instead of re-painting.
          willChange: "transform",
          ...style,
        }}
      />
    </div>
  );
}
