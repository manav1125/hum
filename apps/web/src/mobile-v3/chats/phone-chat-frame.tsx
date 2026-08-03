/**
 * PhoneChatFrame — the phone conversation's layout, and nothing else (v25 · G3).
 *
 * Three slots stacked in a column that fills the screen exactly once:
 *
 *     ┌───────────────────────────┐  header  — flex-shrink:0, pinned, never
 *     │ ‹  Acme pricing      (M)  │            inside a scroller (spec 5)
 *     ├───────────────────────────┤
 *     │                           │  thread  — flex:1 min-height:0, the ONLY
 *     │        …                  │            thing the keyboard resizes,
 *     │   newest message          │            bottom-anchored (specs 1, 2)
 *     ├───────────────────────────┤
 *     │  [ dock ]                 │  composer — flex-shrink:0, bottom inset =
 *     │  ⌨ …                 ↑   │             keyboard, on the system curve
 *     └───────────────────────────┘             (spec 3)
 *
 * What makes it correct is what it does NOT do: no `transform`, no `position:
 * fixed`, no `scrollIntoView`, no window scroll. The keyboard takes height from
 * the thread and gives it back; the header and the composer are laid out around
 * whatever is left. There is no state in which the window has moved, because
 * nothing here can move it.
 *
 * The flex column performs the arithmetic at runtime. `phone-keyboard.ts` holds
 * the same arithmetic as a pure function so it can be tested at both thread
 * sizes design asked for, and so `tabBarVisible` / `composerBottomInset` have
 * one definition rather than being re-derived per caller.
 *
 * Bottom anchoring is `margin-top: auto` on the scroller's content rather than
 * `justify-content: flex-end` on the scroller. Same result — a short thread
 * sits against the composer — without flex-end's habit of making the overflowing
 * top of a long thread unreachable. Design specified the behaviour; this is the
 * implementation of it that survives 200 messages.
 */

import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

import { KEYBOARD_CURVE, nextScrollTop, type PhoneFrame } from "./phone-keyboard";

/**
 * Default scroller to bottom-anchor: the transcript's own scroll container.
 * Targeted by its stable test id because `Transcript` is shared with desktop
 * and must not grow a phone-only prop for a phone-only layout rule.
 */
export const DEFAULT_THREAD_SCROLLER_SELECTOR =
  '[data-testid="transcript-scroll-container"]';

export interface PhoneChatFrameProps {
  frame: PhoneFrame;
  shellRef: React.RefObject<HTMLDivElement | null>;
  headerRef: React.RefObject<HTMLDivElement | null>;
  composerRef: React.RefObject<HTMLDivElement | null>;
  dragHandlers?: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
  /** Pinned, compact, always one line's worth of chrome (spec 5). */
  header: ReactNode;
  /** The conversation. Owns the only scroller on the screen. */
  thread: ReactNode;
  /**
   * Anything that rides directly above the composer — the live-activity block,
   * error cards, the voice bar. Rendered INSIDE the measured composer region so
   * it takes height from the thread instead of covering it.
   */
  dock?: ReactNode;
  composer: ReactNode;
  /** Overrides the bottom-anchored scroller selector (tests, other threads). */
  threadScrollerSelector?: string;
  /** Anything else that belongs in the shell: backdrops, portals, sheets. */
  children?: ReactNode;
  /**
   * Remaining attributes land on the shell element — `data-*` hooks, aria, a
   * className. `style` is merged AFTER the layout, so a caller can theme the
   * shell but cannot quietly reintroduce a transform: the layout writes
   * `transform: none` and any override would have to be written out loud.
   */
  shellProps?: React.HTMLAttributes<HTMLDivElement> &
    Record<`data-${string}`, string | boolean | undefined>;
  className?: string;
  style?: React.CSSProperties;
}

export function PhoneChatFrame({
  frame,
  shellRef,
  headerRef,
  composerRef,
  dragHandlers,
  header,
  thread,
  dock,
  composer,
  threadScrollerSelector = DEFAULT_THREAD_SCROLLER_SELECTOR,
  children,
  shellProps,
  className,
  style,
}: PhoneChatFrameProps) {
  const threadRef = useRef<HTMLDivElement | null>(null);

  // Spec 6 — the reader's position survives the thread changing height.
  //
  // This is where the first version of this frame was wrong, and the
  // 200-message case is what caught it: when the viewport shrinks by a
  // keyboard's height, `scrollTop` is unchanged but the content under it is
  // not, so the newest message slid 296px below the fold and the thread looked
  // like it had jumped to the middle of the conversation. A 2-message thread
  // hid it completely, because it does not scroll at all.
  //
  // The trigger is the SCROLLER'S OWN clientHeight rather than the keyboard:
  // when an ancestor has already absorbed the keyboard this frame's inset never
  // changes, so watching the inset means never reacting. Viewport height is what
  // actually moved, and it is also the right trigger for the composer growing to
  // five lines and for the dock appearing. Deliberately NOT scrollHeight —
  // streaming growth belongs to the transcript's scroll coordinator, and two
  // components adjusting one scroller is how a thread starts fighting a thumb.
  /**
   * ONE remembered number: the thread viewport's height at the last commit.
   *
   * Everything else is read live at correction time, and that is the point.
   * The obvious design — snapshot `{scrollTop, scrollHeight, clientHeight}` on
   * every scroll, compare later — makes the correction only as good as the last
   * scroll event it happened to receive, and a missed one sends the reader to a
   * position they left minutes ago. (Driving this in an embedder that delivers
   * no scroll, `ResizeObserver` or `requestAnimationFrame` callbacks at all made
   * that failure loud, but a dropped event on a real device is the same bug
   * quieter.)
   *
   * Live reads are also simply more correct. A viewport resize does not change
   * `scrollTop` when the viewport SHRINKS, and when it grows the browser has
   * already clamped `scrollTop` to the new maximum — which is the bottom pin,
   * the answer we would have computed anyway. So the current values are the
   * pre-change values, and only the old height has to be remembered.
   */
  const lastClientHeight = useRef<{
    element: HTMLElement;
    clientHeight: number;
  } | null>(null);

  /** If the thread's viewport changed height, hold the reader where they were. */
  const holdReadingPosition = useCallback(() => {
    const region = threadRef.current;
    const el = region?.querySelector<HTMLElement>(threadScrollerSelector);
    if (!el) return;
    const prev = lastClientHeight.current;
    const clientHeight = el.clientHeight;

    // No memory, a different scroller (conversation switch remounts it), or a
    // height that did not change → remember, and move nothing.
    if (!prev || prev.element !== el || prev.clientHeight === clientHeight) {
      lastClientHeight.current = { element: el, clientHeight };
      return;
    }

    el.scrollTop = nextScrollTop({
      prevScrollTop: el.scrollTop,
      prevScrollHeight: el.scrollHeight,
      prevClientHeight: prev.clientHeight,
      nextScrollHeight: el.scrollHeight,
      nextClientHeight: clientHeight,
    });
    lastClientHeight.current = { element: el, clientHeight };
  }, [threadScrollerSelector]);

  // A second trigger, not the only one. ResizeObserver catches height changes
  // the frame's own model never sees — a late web font, an image settling, a
  // dock row appearing — but it is not something to depend on alone: it does
  // not fire in every engine a build gets driven through (an unpainted document
  // delivers neither it nor rAF), and a scroll rule that silently does nothing
  // is worse than one that is obviously absent.
  useLayoutEffect(() => {
    const region = threadRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => holdReadingPosition());
    observer.observe(region);
    return () => observer.disconnect();
  }, [holdReadingPosition]);

  // Every commit. The keyboard reaches this component as a re-render (the frame
  // is state), so a commit is the earliest moment the new height exists — and
  // a layout effect runs before the browser paints, so the correction lands in
  // the same frame as the resize rather than one frame of visible jump later.
  // When nothing changed this is a single `clientHeight` read.
  useLayoutEffect(() => {
    holdReadingPosition();
  });

  const anchorCss = `
[data-phone-chat-frame] [data-phone-thread] ${threadScrollerSelector} {
  overscroll-behavior: contain;
}
/* Bottom-anchored thread (spec 2): a short thread sits against the composer
   rather than floating at the top, and a new message appears with no jump. */
[data-phone-chat-frame] [data-phone-thread] ${threadScrollerSelector} > * {
  margin-top: auto;
}
@media (prefers-reduced-motion: reduce) {
  [data-phone-chat-frame] [data-phone-composer] { transition: none !important; }
}
`;

  return (
    <div
      {...shellProps}
      ref={shellRef}
      data-phone-chat-frame
      data-keyboard-open={frame.keyboardOpen ? "true" : "false"}
      className={className}
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        // `clip` on both axes: `hidden` still lets focus and streaming
        // autoscroll drift the box sideways and stick there.
        overflow: "clip",
        // The invariant, written down. A transform here is the bug.
        transform: "none",
        ...style,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: anchorCss }} />

      {children}

      <div
        ref={headerRef}
        data-phone-chat-header
        style={{ flexShrink: 0, position: "relative", zIndex: 6 }}
      >
        {header}
      </div>

      <div
        ref={threadRef}
        data-phone-thread
        onTouchStart={dragHandlers?.onTouchStart}
        onTouchMove={dragHandlers?.onTouchMove}
        onTouchEnd={dragHandlers?.onTouchEnd}
        style={{
          // The one elastic child. Everything the keyboard does, it does here.
          flex: "1 1 0%",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          zIndex: 2,
        }}
      >
        {thread}
      </div>

      <div
        ref={composerRef}
        data-phone-composer
        style={{
          flexShrink: 0,
          position: "relative",
          zIndex: 5,
          // Spec 3 — the composer sits ON the keyboard, and rises with it.
          paddingBottom: frame.composerBottomInset || undefined,
          transition: `padding-bottom ${KEYBOARD_CURVE}`,
        }}
      >
        {dock}
        {composer}
      </div>
    </div>
  );
}
