/**
 * SharedMobileHeader — the round-4 "desktop-rescue" header grammar (spec
 * frame 54, docs/design/mobile-round4/cue-mobile-round4.html). One pattern
 * for every desktop-shell page that reaches a phone: Contacts, Marketplace,
 * Workspace, any fallthrough.
 *
 * The grammar, read off the frame:
 *  · Row 1 — back "‹ ‹parent›" left (16px, `--mv3-micro`), ≤2 icon actions
 *    right (32px circles inside 44pt hit targets), min-height 44pt, sits
 *    below the safe area.
 *  · Row 2 — page title 28/700/−0.7px, one line, truncates.
 *  · Row 3 (optional) — horizontally scrolling filter pills, count on the
 *    ACTIVE pill only, no scrollbar, right-edge fade.
 *  · On scroll: the title condenses into row 1 center at 17/600 (standard
 *    iOS large-title physics — same rAF transform/opacity approach as
 *    `LargeTitleHeader`); pills pin.
 */
import { useEffect, useRef } from "react";

import { haptic } from "@/utils/haptics";

/** Scroll distance (px) over which the large title hands off to the compact. */
export const CONDENSE_RANGE = 44;

/** 0→1 condense progress for a scroll offset (pure — exported for tests). */
export function condenseProgress(scrollTop: number): number {
  return Math.min(1, Math.max(0, scrollTop / CONDENSE_RANGE));
}

export interface SharedHeaderAction {
  key: string;
  /** Accessible name for the 44pt action button. */
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  /** Render the circle filled-active (e.g. a toggled search). */
  active?: boolean;
}

export interface SharedHeaderPill {
  value: string;
  label: string;
  /** Shown only while the pill is active (spec: count on the active pill). */
  count?: number;
}

/** Pill display label — count rides only on the active pill (pure). */
export function pillLabel(pill: SharedHeaderPill, active: boolean): string {
  return active && typeof pill.count === "number"
    ? `${pill.label} · ${pill.count}`
    : pill.label;
}

export function SharedMobileHeader({
  backLabel,
  onBack,
  title,
  actions = [],
  pills,
  activePill,
  onPillChange,
  scrollRef,
}: {
  /** Parent name after the chevron — "‹ You". */
  backLabel: string;
  onBack: () => void;
  title: string;
  /** Up to 2 icon actions; extras are dropped (spec: ≤2). */
  actions?: SharedHeaderAction[];
  /** Optional row-3 filter pills. */
  pills?: SharedHeaderPill[];
  activePill?: string;
  onPillChange?: (value: string) => void;
  /** Scroll container whose offset drives the large-title condense. */
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  const largeRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollRef?.current;
    if (!scroller) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const t = condenseProgress(scroller.scrollTop);
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

  const visibleActions = actions.slice(0, 2);

  return (
    <div
      data-mv3
      style={{
        flexShrink: 0,
        position: "relative",
        zIndex: 2,
        padding:
          "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 6px) 20px 0",
        borderBottom: "1px solid var(--mv3-line)",
        background: "var(--mv3-bg)",
        fontFamily: "var(--mv3-font)",
        color: "var(--mv3-text)",
      }}
    >
      {/* Row 1 — back + icon actions, with the compact title centered. */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 10,
          minHeight: 44,
        }}
      >
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onBack();
          }}
          style={{
            fontSize: 16,
            color: "var(--mv3-micro)",
            background: "none",
            border: "none",
            padding: "6px 0",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            cursor: "pointer",
            fontFamily: "inherit",
            position: "relative",
            zIndex: 1,
          }}
        >
          ‹ {backLabel}
        </button>

        {/* Compact centered title — hidden until the scroller condenses. */}
        <div
          ref={compactRef}
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: "-0.3px",
            opacity: 0,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>

        {visibleActions.length > 0 ? (
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 6,
              position: "relative",
              zIndex: 1,
            }}
          >
            {visibleActions.map((action) => (
              <button
                key={action.key}
                type="button"
                aria-label={action.label}
                aria-pressed={action.active ?? undefined}
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  action.onPress();
                }}
                style={{
                  width: 44,
                  height: 44,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: action.active
                      ? "var(--mv3-text)"
                      : "var(--mv3-btn2-bg)",
                    border: action.active
                      ? "1px solid transparent"
                      : "1px solid var(--mv3-btn2-border)",
                    color: action.active ? "var(--mv3-bg)" : "var(--mv3-muted)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                  }}
                >
                  {action.icon}
                </span>
              </button>
            ))}
          </span>
        ) : null}
      </div>

      {/* Row 2 — large title (condenses into row 1). */}
      <div
        ref={largeRef}
        style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: "-0.7px",
          padding: "2px 0 12px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </div>

      {/* Row 3 — optional scrolling filter pills with a right-edge fade. */}
      {pills && pills.length > 0 ? (
        <div style={{ position: "relative" }}>
          <div
            role="group"
            aria-label={`Filter ${title}`}
            style={{
              display: "flex",
              gap: 7,
              overflowX: "auto",
              WebkitOverflowScrolling: "touch",
              scrollbarWidth: "none",
              paddingBottom: 12,
              // Let the last pill clear the fade overlay.
              paddingRight: 24,
            }}
          >
            {pills.map((pill) => {
              const active = pill.value === activePill;
              return (
                <button
                  key={pill.value}
                  type="button"
                  aria-pressed={active}
                  className="cue-pressable"
                  onClick={() => {
                    haptic.light();
                    onPillChange?.(pill.value);
                  }}
                  style={{
                    flexShrink: 0,
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 400,
                    fontFamily: "inherit",
                    color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
                    background: active
                      ? "var(--mv3-text)"
                      : "var(--mv3-btn2-bg)",
                    border: active
                      ? "1px solid transparent"
                      : "1px solid var(--mv3-btn2-border)",
                    borderRadius: 99,
                    padding: "7px 14px",
                    minHeight: 32,
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  {pillLabel(pill, active)}
                </button>
              );
            })}
          </div>
          {/* Right-edge fade (spec: pills scroll under a fade, no scrollbar). */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              right: -20,
              bottom: 0,
              width: 44,
              pointerEvents: "none",
              background:
                "linear-gradient(90deg, transparent, var(--mv3-bg) 70%)",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
