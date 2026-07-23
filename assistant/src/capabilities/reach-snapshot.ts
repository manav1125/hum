/**
 * The reach snapshot — "whose machine, and whose browser, can Cue actually
 * touch right now?"
 *
 * The capability snapshot answers "does Cue have a browser tool?". That is not
 * the same question as "can Cue reach the browser the USER is logged into",
 * and conflating the two produced a real, traced failure: asked to "access my
 * Netlify account — you can control my browser", the daemon drove the throwaway
 * Playwright browser running inside its own container, found it logged out (of
 * course), and reported that back as if it were the user's session.
 *
 * Reach is derived live from the connected-client registry, never assumed:
 *
 *   - the user's own Chrome is reachable only through a connected Chrome
 *     Extension or the desktop host_browser bridge;
 *   - the user's Mac is reachable only through a connected host_bash client;
 *   - the in-container Playwright browser is always there, and is always a
 *     DIFFERENT browser from the user's — a fresh profile with no cookies and
 *     no logged-in sessions.
 *
 * Never throws: a registry failure degrades to "unknown", which callers report
 * honestly rather than turning into a claim.
 */

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("reach-snapshot");

/** How the user's own browser is reachable, if at all. */
export type UserBrowserRoute = "extension" | "host-bridge" | null;

export interface ReachSnapshot {
  /**
   * The user's own Chrome — the one holding their logged-in sessions.
   * `route` is null when no route exists, in which case browser tools fall
   * through to the in-container browser.
   */
  userBrowser: { reachable: boolean; route: UserBrowserRoute };
  /** The user's Mac (shell + files), via a connected desktop client. */
  userMac: { reachable: boolean };
  /**
   * True when the registry could not be read at all. Callers must say
   * "unknown" rather than "not reachable" — an underclaim is still a claim.
   */
  unknown: boolean;
}

/**
 * The slice of the client registry this module reads. Declared as an interface
 * (and injectable below) so tests can supply a registry without replacing the
 * event-hub module wholesale — mirrors `pickSameUserAutoResolve({ hub, … })`.
 */
export interface ClientRegistryReader {
  listClientsByCapability(
    capability: "host_browser" | "host_bash",
  ): ReadonlyArray<{ actorPrincipalId?: string }>;
  listClientsByInterface(
    interfaceId: "chrome-extension",
  ): ReadonlyArray<{ actorPrincipalId?: string }>;
}

/**
 * Probe live reach. `sourceActorPrincipalId` scopes the probe to one actor on
 * a multi-actor daemon; omitted (the self-host owner case, where the local
 * principal carries no actor id) means "any connected client counts", which is
 * exactly the rule the CDP factory and the host proxies apply at dispatch time.
 */
export function buildReachSnapshot(opts?: {
  sourceActorPrincipalId?: string;
  registry?: ClientRegistryReader;
}): ReachSnapshot {
  const actor = opts?.sourceActorPrincipalId;
  const registry: ClientRegistryReader = opts?.registry ?? assistantEventHub;
  try {
    const matches = (clients: ReadonlyArray<{ actorPrincipalId?: string }>) =>
      actor == null
        ? clients.length > 0
        : clients.some((c) => c.actorPrincipalId === actor);

    const extension = matches(
      registry.listClientsByInterface("chrome-extension"),
    );
    const bridge = matches(registry.listClientsByCapability("host_browser"));
    const mac = matches(registry.listClientsByCapability("host_bash"));

    return {
      userBrowser: {
        reachable: extension || bridge,
        route: extension ? "extension" : bridge ? "host-bridge" : null,
      },
      userMac: { reachable: mac },
      unknown: false,
    };
  } catch (err) {
    log.debug({ err: String(err) }, "client registry unavailable for reach");
    return {
      userBrowser: { reachable: false, route: null },
      userMac: { reachable: false },
      unknown: true,
    };
  }
}

/**
 * Render the reach snapshot as prompt lines. Deliberately blunt: the model has
 * to be able to answer "can you get into my Netlify account?" from this text
 * alone, without probing, and without discovering the answer only after it has
 * already driven a cookie-less browser and read a login page.
 */
export function renderReachLines(snapshot: ReachSnapshot): string[] {
  if (snapshot.unknown) {
    return [
      "- Your browser / your Mac: unknown right now (the client registry could not be read). Say so rather than assuming either way.",
    ];
  }

  const lines: string[] = [];

  if (snapshot.userBrowser.reachable) {
    lines.push(
      snapshot.userBrowser.route === "extension"
        ? "- The user's own Chrome: REACHABLE via the connected Chrome extension. The `browser_*` tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_extract, …) drive their real browser, with their real logged-in sessions. For ANY web task — opening a site, filling a web form, reading a page, \"do X on this website\" — navigate, then browser_snapshot to get element ids, then browser_click/browser_type on them. Do NOT use `computer_use_*` screen-control to click around a browser: that is the wrong tool for the web and hijacks their screen. `computer_use_*` is for native desktop apps only."
        : "- The user's own Chrome: REACHABLE via the desktop bridge. The `browser_*` tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_extract, …) drive their real browser, with their real logged-in sessions. For ANY web task — opening a site, filling a web form, reading a page, \"do X on this website\" — navigate, then browser_snapshot to get element ids, then browser_click/browser_type on them. Do NOT use `computer_use_*` screen-control to click around a browser: that is the wrong tool for the web and hijacks their screen. `computer_use_*` is for native desktop apps only.",
    );
  } else {
    lines.push(
      "- The user's own browser: NOT reachable. No Chrome extension and no desktop bridge is connected, so browser tools fall through to a throwaway browser inside Cue's own container — a different browser, with no cookies and none of the user's logged-in sessions.",
      "  So: you cannot open anything the user is signed into (their Netlify, their bank, their Gmail) by driving the browser. Being logged out there proves nothing about their account. Say this plainly and stop, rather than reporting what the container browser saw as though it were theirs.",
    );
  }

  lines.push(
    snapshot.userMac.reachable
      ? "- The user's Mac (shell, files, apps): REACHABLE via the connected desktop client."
      : "- The user's Mac (shell, files, apps): NOT reachable — no desktop client is connected. `bash` runs inside Cue's container, not on their machine.",
  );

  return lines;
}
