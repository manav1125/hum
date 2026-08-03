import { useEffect, useState } from "react";

export interface VisibleViewport {
  /** Height of the visual viewport in pixels — the area actually visible to the user. */
  height: number;
  /**
   * Height in pixels of the on-screen keyboard (or other virtual widget)
   * that's covering the layout viewport. `0` when no keyboard is visible.
   */
  keyboardHeight: number;
  /**
   * Offset in pixels between the top edge of the visual viewport and the top
   * edge of the layout viewport. iOS sets this when it auto-positions the
   * visible viewport above the soft keyboard. Always `0` on Android and
   * desktop. Always `0` while pinch-zoomed (we ignore zoom-induced offset).
   */
  offsetTop: number;
  /**
   * Offset in pixels between the left edge of the visual viewport and the
   * layout viewport. Non-zero only during pinch-zoom panning (which we
   * ignore, see `offsetTop`). Exposed for completeness and to round-trip
   * symmetrically with `offsetTop` through `translate()`.
   */
  offsetLeft: number;
}

// Stable reference for the viewport height when no keyboard is present.
//
// In Safari, `window.innerHeight` stays at the layout viewport height when the
// keyboard opens and only `visualViewport.height` shrinks, so
// `innerHeight - vv.height` directly yields the keyboard height.
//
// In WKWebView (Capacitor iOS without `@capacitor/keyboard`), the web view
// frame itself is resized to fit above the keyboard. Both `innerHeight` and
// `vv.height` shrink together, making `innerHeight - vv.height ≈ 0` even when
// the keyboard is visible. Comparing against a remembered keyboard-dismissed
// `innerHeight` makes keyboard detection work across both runtimes.
//
// WHICH remembered value is the whole difficulty, and it used to be "the
// largest ever seen", which only ever went UP. That is a guess that cannot be
// corrected: any event that permanently shrinks the layout viewport — a
// rotation, a WKWebView frame change, browser chrome appearing — left the
// reference stale-high, and `referenceInnerHeight - vv.height` then reported a
// keyboard of 60–120px with no keyboard on screen. Past the 100px threshold
// `RootLayout` sizes its shell to `visualViewport.height` and adds a matching
// `paddingTop`, so the app resized itself while the user was only browsing.
// The mirror-image bug: the orientation reset re-sampled `innerHeight` at the
// instant of the flip, which can be a keyboard-SHRUNK height, and then the app
// insisted the keyboard was closed while it was plainly up.
//
// The fix is to stop guessing when the answer is knowable. A soft keyboard
// requires an editable element to be focused — in every runtime, with no
// exceptions. So while nothing editable holds focus, the reference is simply
// set to the current `innerHeight`, in BOTH directions; it is only frozen (and
// allowed to ratchet up, for a rotation mid-typing) while a field is focused
// and the frame may be keyboard-shrunk. Drift now self-corrects the moment the
// user taps away, instead of persisting for the life of the page.
let referenceInnerHeight =
  typeof window !== "undefined" ? window.innerHeight : 0;

// Orientation detection via matchMedia — universally supported (iOS 9+),
// unlike screen.orientation which was only added in Safari 16.4.
function isPortrait(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  return window.matchMedia("(orientation: portrait)").matches;
}
let lastIsPortrait: boolean = isPortrait();

/**
 * Whether focus is on something that can raise a soft keyboard.
 *
 * This is the fact the reference was guessing at. `readonly` inputs and
 * non-editing hosts are excluded — they take focus without a keyboard.
 *
 * Exported so tests can assert the two states drive different behaviour rather
 * than reaching into module state.
 */
export function isEditableFocused(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return !(el as HTMLTextAreaElement).readOnly;
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    // Pickers, checkboxes and buttons focus without raising a keyboard.
    const noKeyboard = new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ]);
    return !input.readOnly && !noKeyboard.has(input.type);
  }
  return false;
}

/**
 * Read the current visual-viewport state.
 *
 * Exported so unit tests can drive the function against a stubbed
 * `window.visualViewport` without mounting React.
 */
export function readVisibleViewport(): VisibleViewport | null {
  if (!window.visualViewport) {
    return null;
  }
  const vv = window.visualViewport;

  // A rotation legitimately changes the viewport dimensions and would
  // otherwise look like a keyboard event — but only re-sample the reference
  // if nothing editable holds focus. Rotating mid-typing used to capture the
  // keyboard-shrunk height as "the height with no keyboard", after which the
  // app reported the keyboard closed while the user was still typing into it.
  const currentIsPortrait = isPortrait();
  const typing = isEditableFocused();
  if (currentIsPortrait !== lastIsPortrait) {
    lastIsPortrait = currentIsPortrait;
    if (!typing) referenceInnerHeight = window.innerHeight;
  }

  if (!typing) {
    // Nothing can be covering the viewport, so this IS the reference — take it
    // downwards as readily as upwards. Only-upwards was the drift that made the
    // shell resize itself mid-browse.
    referenceInnerHeight = window.innerHeight;
  } else if (window.innerHeight > referenceInnerHeight) {
    // Focused: the frame may be keyboard-shrunk, so never lower the reference.
    // Growth is still real (a rotation to a taller layout viewport while the
    // keyboard is up), so it still ratchets.
    referenceInnerHeight = window.innerHeight;
  }

  // When pinch-zoomed (scale > 1) the visual viewport height shrinks in CSS
  // pixels, which would otherwise inflate keyboardHeight and falsely trigger
  // keyboard-open detection. Only derive keyboardHeight at ~1.0 scale.
  const isZoomed = Math.abs(vv.scale - 1) > 0.05;
  return {
    height: vv.height,
    keyboardHeight: isZoomed
      ? 0
      : Math.max(0, referenceInnerHeight - vv.height),
    offsetTop: isZoomed ? 0 : vv.offsetTop,
    offsetLeft: isZoomed ? 0 : vv.offsetLeft,
  };
}

/**
 * Tracks the VisualViewport API so callers can size and position containers
 * to the area actually visible to the user.
 *
 * In Safari, the soft keyboard shrinks `visualViewport.height` while
 * `window.innerHeight` stays at the full layout viewport. In Capacitor's
 * WKWebView (without `@capacitor/keyboard`), the web view frame itself
 * resizes, shrinking both values together. The `referenceInnerHeight`
 * approach in `readVisibleViewport` handles both cases — see the module-level
 * comment above it.
 *
 * Returns `null` in browsers that lack the API; callers should fall back to
 * `100dvh` (and no transform) in that case.
 *
 * @see https://developer.chrome.com/blog/visual-viewport-api/
 * @see https://bugs.webkit.org/show_bug.cgi?id=207049
 */
export function useVisibleViewport(): VisibleViewport | null {
  const [state, setState] = useState<VisibleViewport | null>(null);

  useEffect(() => {
    if (!window.visualViewport) {
      return;
    }
    const vv = window.visualViewport;
    const update = () => setState(readVisibleViewport());
    update();
    // `resize` fires on width/height/scale changes; `scroll` fires on
    // offsetTop/offsetLeft changes. Both must be observed — iOS commonly
    // fires one without the other during a single keyboard transition.
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return state;
}
