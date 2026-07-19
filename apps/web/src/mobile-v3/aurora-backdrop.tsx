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
      data-mv3
      style={{
        position: "absolute",
        inset: "-20%",
        background:
          "radial-gradient(44% 30% at 50% 4%, var(--mv3-aurora), transparent 68%)",
        filter: "blur(30px)",
        animation: "mv3Aur 12s ease-in-out infinite",
        pointerEvents: "none",
        // Own layer so the one-time blur rasterization is reused across the
        // transform animation instead of re-painting.
        willChange: "transform",
        ...style,
      }}
    />
  );
}
