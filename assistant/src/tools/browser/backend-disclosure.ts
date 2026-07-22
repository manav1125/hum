/**
 * Browser-backend disclosure.
 *
 * Every browser tool result must say WHICH browser it drove. The factory picks
 * a backend from an ordered candidate list and falls through to the
 * in-container Playwright browser when no route to the user's own Chrome
 * exists — and that fall-through used to be silent. The consequence, traced on
 * prod: asked to "access my Netlify account — you can control my browser",
 * Cue drove the container browser (fresh profile, no cookies, no sessions),
 * found a logged-out page, and reported "not logged in" as if it had looked at
 * the user's account. It had not. It had looked at a different browser, and
 * the result read identically either way.
 *
 * So: the selected backend goes into the tool result, in words, on every call.
 * On the `local` fall-through the disclosure is loud and carries an explicit
 * instruction, because that is the case where the model can most easily
 * mistake the container's view for the user's.
 */

import type { CdpClientKind } from "./cdp-client/types.js";

/** One-line label for each backend, in the terms that matter: whose browser. */
const BACKEND_LABELS: Record<CdpClientKind, string> = {
  extension:
    "the user's own Chrome, via the connected extension (their real profile, their real logged-in sessions)",
  "host-bridge":
    "the user's own Chrome on their machine, via the desktop bridge (their real profile, their real logged-in sessions)",
  "cdp-inspect":
    "a Chrome attached over the local remote-debugging port (whichever profile that Chrome was launched with)",
  local:
    "a throwaway Chrome running INSIDE Cue's own container — NOT the user's browser",
};

/** True for backends that actually reach the browser the user is signed into. */
export function isUserOwnedBrowser(kind: CdpClientKind): boolean {
  return kind === "extension" || kind === "host-bridge";
}

/**
 * The disclosure block appended to a browser tool result.
 *
 * `local` gets the extra paragraph because it is the silent-substitution case:
 * the tool succeeded, the page loaded, and nothing in the output would
 * otherwise reveal that the session being read is not the user's.
 */
export function backendDisclosureLines(kind: CdpClientKind): string[] {
  const lines = ["", `Browser used: ${BACKEND_LABELS[kind]}.`];

  if (kind === "local") {
    lines.push(
      "This container browser has no cookies and no logged-in sessions, and no route to the user's own browser was available. Anything it reports about being signed in, signed out, or what an account contains is about THIS browser only — it is not evidence about the user's account.",
      "If the request depends on the user's own session (\"my account\", \"my browser\", \"I'm logged in there\"), stop here and tell them plainly that you cannot reach their browser, rather than continuing and narrating this browser's view as theirs. Do not offer to sign in on their behalf, and never ask them for a password or token.",
    );
  }

  return lines;
}

/**
 * Append the disclosure to an already-built list of result lines.
 * Returns the same array for call-site brevity.
 */
export function withBackendDisclosure(
  lines: string[],
  kind: CdpClientKind,
): string[] {
  lines.push(...backendDisclosureLines(kind));
  return lines;
}
