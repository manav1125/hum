/**
 * "Is the soft keyboard up?" — one definition, for every surface that has to
 * get out of its way.
 *
 * The rule that needs it is v25 · G3 #4: *"Tab bar hides while typing. Returns
 * on dismiss — it's navigation, and you're not navigating."* That is a
 * statement about the KEYBOARD, and the phone had been approximating it with a
 * statement about the ROUTE — the tab bar hid itself on every conversation
 * URL, which is hidden-while-typing plus hidden the rest of the time too. The
 * cost was not cosmetic: with the bar gone from the surface you spend most of
 * your day on, the mark was never pressable at home, and the mark is the only
 * door to Your Cue on this phone.
 *
 * So the signal lives here rather than inside any one surface. A route
 * predicate cannot answer it, and a second copy of the visual-viewport
 * arithmetic would drift from the first.
 *
 * WKWebView: keyboard height comes from `visualViewport`, never from a window
 * resize — under Capacitor the web view frame itself is resized and
 * `innerHeight − visualViewport.height` is ~0 with the keys plainly up.
 * `readVisibleViewport` normalises that; see `use-visible-viewport.ts`.
 */

import { useEffect, useState } from "react";

import { readVisibleViewport } from "@/hooks/use-visible-viewport";
import { KEYBOARD_OPEN_THRESHOLD_PX } from "@/mobile-v3/chats/phone-keyboard";

/**
 * Read the current state without subscribing. Useful in an event handler that
 * needs the answer once.
 */
export function isSoftKeyboardOpen(): boolean {
  if (typeof window === "undefined") return false;
  const viewport = readVisibleViewport();
  return (viewport?.keyboardHeight ?? 0) > KEYBOARD_OPEN_THRESHOLD_PX;
}

/**
 * Subscribe to the soft keyboard's presence.
 *
 * `false` in every environment without a soft keyboard, so a caller can gate on
 * it unconditionally: the fallback is "shown", never "hidden". A signal that
 * fails closed would hide navigation on desktop, and hiding a user's way out on
 * a failure is the wrong direction to fail in.
 */
export function useSoftKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setOpen(isSoftKeyboardOpen());
    update();
    const vv = window.visualViewport;
    // `resize` carries the height change; `scroll` carries iOS shifting the
    // visual viewport up. iOS fires one without the other often enough that
    // listening to only one loses transitions.
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return open;
}
