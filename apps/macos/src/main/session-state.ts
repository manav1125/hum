/**
 * Whether anybody is signed in.
 *
 * **Why this is its own module.** It arrived as a Dock concern — whether to
 * keep the icon after the last window closes — and lived in `dock.ts`. But it
 * is the only signal main has for "there is a session now", and more than the
 * Dock needs it: **any window that loads the SPA before there is a session
 * renders the sign-in screen instead of itself**, and nothing reloads it when
 * the session arrives. That bug shipped in 1.3.0 as a second Welcome window
 * sitting beside the real one.
 *
 * Kept free of Electron so the surfaces that gate on it can be tested without
 * a window — importing `dock.ts` for this pulled `nativeImage` into every
 * suite that asked.
 *
 * The renderer is still the source (`vellum:dock:setSignedIn`, published from
 * the signed-in app shell). When main owns auth directly this module is where
 * that lands, and nothing that reads it has to change.
 */

let signedIn = false;

const listeners = new Set<(signedIn: boolean) => void>();

export const isSignedIn = (): boolean => signedIn;

/**
 * Record the session state, and tell anyone who cares — but only when it
 * actually changed. The renderer republishes on every mount, and a surface
 * that reopened itself on each of those would flicker.
 */
export const setSignedIn = (next: boolean): boolean => {
  if (signedIn === next) return false;
  signedIn = next;
  for (const listener of listeners) listener(next);
  return true;
};

export const onSignedInChange = (
  listener: (signedIn: boolean) => void,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Test seam. */
export const __resetForTesting = (): void => {
  signedIn = false;
  listeners.clear();
};
