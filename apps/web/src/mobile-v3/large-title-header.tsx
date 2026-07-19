/**
 * LargeTitleHeader — iOS large-title physics for mv3 screens.
 *
 * A large left-aligned title (spec: 29px/700, −0.8px tracking) that condenses
 * into a compact centered title as the associated scroll container scrolls.
 * Implementation notes:
 *   · transform/opacity ONLY — the compact title fades/slides in and the
 *     large title fades/slides out; nothing re-layouts per frame.
 *   · scroll handling writes to element styles directly through rAF (no
 *     React re-render per scroll tick).
 *   · reduced-motion: handled naturally — values are driven by scroll
 *     position (direct manipulation), not by autonomous animation, which
 *     iOS itself keeps under reduced motion. No timed animation is used.
 *
 * Usage: pass the scrollable element via `scrollRef` (the mv3 screen's
 * card-stack scroller). The header itself stays outside the scroller
 * (spec's Today keeps header + hero fixed above the stack).
 */
import { useEffect, useRef } from "react";

/** Scroll distance (px) over which the large title hands off to the compact one. */
const CONDENSE_RANGE = 44;

export function LargeTitleHeader({
  eyebrow,
  title,
  trailing,
  scrollRef,
}: {
  /** Mono microlabel row above the title (e.g. "SATURDAY · JUL 19"). */
  eyebrow?: React.ReactNode;
  title: string;
  /** Right-aligned ornament on the eyebrow row (e.g. the avatar chip). */
  trailing?: React.ReactNode;
  /** The scroll container whose offset drives the condense. */
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  const largeRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLDivElement>(null);
  const eyebrowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollRef?.current;
    if (!scroller) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const y = scroller.scrollTop;
      const t = Math.min(1, Math.max(0, y / CONDENSE_RANGE));
      const large = largeRef.current;
      const compact = compactRef.current;
      if (large) {
        large.style.opacity = String(1 - t);
        large.style.transform = `translateY(${-6 * t}px)`;
      }
      if (compact) {
        compact.style.opacity = String(t);
        compact.style.transform = `translateY(${(1 - t) * 6}px)`;
      }
      // The eyebrow yields to the compact centered title (it would overlap).
      const eyebrow = eyebrowRef.current;
      if (eyebrow) eyebrow.style.opacity = String(1 - t);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    apply();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  return (
    <div
      data-mv3
      style={{
        padding: "6px 22px 0",
        flexShrink: 0,
        position: "relative",
        zIndex: 2,
        fontFamily: "var(--mv3-font)",
        color: "var(--mv3-text)",
      }}
    >
      {/* Compact centered title — hidden until the scroller condenses. */}
      <div
        ref={compactRef}
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 4,
          textAlign: "center",
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: "-0.3px",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        {title}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {eyebrow ? (
          <div
            ref={eyebrowRef}
            style={{
              fontFamily: "var(--mv3-mono)",
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--mv3-micro)",
            }}
          >
            {eyebrow}
          </div>
        ) : (
          <span />
        )}
        {trailing ?? null}
      </div>

      <div
        ref={largeRef}
        style={{
          fontSize: 29,
          fontWeight: 700,
          letterSpacing: "-0.8px",
          marginTop: 4,
          lineHeight: 1.08,
        }}
      >
        {title}
      </div>
    </div>
  );
}
