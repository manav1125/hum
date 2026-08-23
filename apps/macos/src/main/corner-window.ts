import { screen, type BrowserWindow } from "electron";
import { z } from "zod";

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle } from "./ipc";
import {
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
} from "./main-window";
import {
  noteSummonAndShouldOffer,
  readFrontWindow,
  screenReadConsent,
  setScreenReadConsent,
  type ScreenRead,
} from "./corner-screen-read";
import { readSelection, type Selection } from "./selection-read";
import { readSetting } from "./settings";
import { restoreBounds, track as trackWindowState } from "./window-state";
import { isCornerEnabled } from "./desktop-surface-flags";

/**
 * The floating corner — one exchange, then finished.
 *
 * Most AI is a place you go to; an overlay comes to you. The corner Cue
 * shipped before this was the heavy app in a small window — a place you go
 * to, shrunk — which is both too small to work in and too heavy to glance at.
 * This one does exactly one job: get a thought or a question in and out
 * without leaving what you are doing.
 *
 * ## The rules, and where each is kept
 *
 *  1. **It is never a thread.** One exchange. "Open in Cue ›" hands the whole
 *     thing to the app — the escape hatch that stops the panel growing back
 *     into the app. Enforced in the renderer, which holds no history.
 *  2. **Every action carries a local Undo**, beside the claim rather than in
 *     a toast that expires. Renderer.
 *  3. **`esc` closes and never cancels work in flight.** Closing the window
 *     must never be a way to lose an action halfway; anything running
 *     continues and reports in HQ. That is why {@link hideCornerWindow} only
 *     hides — it sends no cancel, and nothing here is wired to one.
 *  4. **It never appears unbidden.** There is no code path that opens this
 *     window except the summon. Approvals reach the owner as a menu-bar count
 *     they pull down; a panel that seizes focus to ask for money is the
 *     behaviour that gets an app quit.
 *  5. **It remembers its corner** and never repositions itself or follows the
 *     cursor — `trackWindowState` persists where it was put, and nothing
 *     recomputes a position after first run.
 *
 * ## Why the selection is read before the window is shown
 *
 * The summon fires while the owner's own app is frontmost, and that is the
 * only moment their selection can be read. So the order is: read, then show.
 * The window is a non-activating panel, but even so, showing first would race
 * the read against the focus change.
 */

const CORNER_KIND = "corner";
const CORNER_PATH = "/floating/corner";

const CORNER_FLAG_KEY = "desktop-corner";
const CORNER_FLAG_ENV = "VELLUM_FLAG_DESKTOP_CORNER";

const ENV_TRUE = new Set(["true", "1", "yes", "on"]);
const ENV_FALSE = new Set(["false", "0", "no", "off"]);

/**
 * `VELLUM_FLAG_DESKTOP_CORNER` override — same token set and same shape as
 * the companion's, so one env var pattern drives every desktop surface.
 */
const envFlagOverride = (): boolean | null => {
  const raw = process.env[CORNER_FLAG_ENV]?.trim().toLowerCase();
  if (!raw) return null;
  if (ENV_TRUE.has(raw)) return true;
  if (ENV_FALSE.has(raw)) return false;
  return null;
};

/**
 * Whether the corner is switched on. **Default off**, and the gate is read at
 * call time so flipping the flag takes effect without a restart.
 *
 * This gate is on the SUMMON, not just the window, and that is the point:
 * turning the corner on claims `⌥C` system-wide, which is a key that types
 * `ç` in every app that does not have it bound. Registering that for someone
 * who has not asked for the feature would be taking something away from them.
 */

/**
 * Sized to the content, not to a round number: the quote block is capped and
 * scrolls, so the two real states — a bare "what do you need?" and a quote
 * plus a composer — both sit tight. A taller panel would leave dead space in
 * the common case, and dead space in a floating panel reads as a window to
 * manage rather than a thing to glance at.
 */
export const CORNER_SIZE = { width: 420, height: 260 } as const;

/** Margin from the work-area corner for the first-run default position. */
const DEFAULT_CORNER_MARGIN = 24;

const cornerWindow = (): BrowserWindow | null => getFloatingWindow(CORNER_KIND);

/**
 * First run: bottom-right of the primary display's work area. After that the
 * persisted position wins, forever — the panel appears where the owner last
 * left it, which is the whole of rule 5.
 */
const defaultCornerPosition = (): { x: number; y: number } => {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return {
    x: x + width - CORNER_SIZE.width - DEFAULT_CORNER_MARGIN,
    y: y + height - CORNER_SIZE.height - DEFAULT_CORNER_MARGIN,
  };
};

/**
 * The selection captured by the most recent summon, handed to the renderer
 * when it asks. Held in main rather than pushed at the window because the
 * route chunk loads lazily — a push can beat the listener, a pull cannot.
 */
let pendingSelection: Selection | null = null;

/**
 * What the front window said, when the owner has granted that. Held beside
 * the selection and cleared the same way — **nothing here is persisted**, so
 * a read that produced no accepted action leaves no trace.
 */
let pendingScreen: ScreenRead | null = null;

/** True when this summon should offer screen-reading (the second one). */
let pendingOffer = false;

const openCornerWindow = (): BrowserWindow => {
  // A position is computed ONLY for a window that does not exist yet. Passing
  // one for an existing window would reposition it on every summon, which is
  // exactly the "never repositions itself" rule — a panel that snaps back to
  // where it was born is a panel you cannot put anywhere.
  const existing = cornerWindow();
  const restored = existing ? null : restoreBounds(CORNER_KIND, CORNER_SIZE);
  const position = !restored
    ? undefined
    : restored.x !== undefined && restored.y !== undefined
      ? { x: restored.x, y: restored.y }
      : defaultCornerPosition();

  const win = createFloatingWindow({
    kind: CORNER_KIND,
    route: CORNER_PATH,
    width: CORNER_SIZE.width,
    height: CORNER_SIZE.height,
    // Focused, unlike the old orb: this one is typed into the moment it
    // opens. The read that needs the other app frontmost has already
    // happened by the time this runs.
    focusOnShow: true,
    alwaysOnTopLevel: "floating",
    visibleOnAllWorkspaces: true,
    ...(position ? { position } : {}),
    browserWindow: {
      movable: true,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
    },
  });

  trackWindowState(CORNER_KIND, win);
  return win;
};

/**
 * Summon the corner — the one and only way this window opens.
 *
 * Reads the selection first (see the module comment), then shows the panel
 * with whatever was found. No selection is a completely ordinary outcome: the
 * panel opens on its plain "what do you need?" state rather than an error.
 *
 * A second summon while the panel is open closes it, so the same key both
 * opens and dismisses — which is what makes it feel like a glance rather than
 * a window to manage.
 */
export const summonCorner = async (): Promise<void> => {
  if (!isCornerEnabled()) return;

  const existing = cornerWindow();
  if (existing?.isVisible()) {
    hideCornerWindow();
    return;
  }

  // Both reads happen while the owner's own app is still frontmost, which is
  // the only moment either is possible. Selection first: it is the primary
  // input and the cheaper call, and a window read that fails must not cost it.
  pendingSelection = await readSelection();
  pendingScreen = await readFrontWindow();
  pendingOffer = noteSummonAndShouldOffer();

  // `createFloatingWindow` shows and focuses (focusOnShow: true) for both a
  // fresh window and an existing hidden one, so there is nothing to do here
  // but hand over what was read.
  const win = openCornerWindow();
  win.webContents.send("vellum:corner:selection", pendingSelection);
  win.webContents.send("vellum:corner:context", {
    screen: pendingScreen,
    offerScreenReading: pendingOffer,
    consent: screenReadConsent(),
  });
};

/**
 * Close the panel.
 *
 * **Hides; never cancels.** `esc` reaches this, and rule 3 is that closing
 * the window is not a way to abandon work halfway — anything already running
 * keeps running and reports in HQ. There is deliberately no abort here to
 * "tidy up" on the way out.
 */
export const hideCornerWindow = (): void => {
  const win = cornerWindow();
  if (win && !win.isDestroyed()) win.hide();
};

/**
 * "Open in Cue ›" — hand the exchange to the app.
 *
 * The panel is not a thread, so when one exchange is not enough the answer is
 * to leave rather than to grow a scrollback. This closes the corner and
 * surfaces the main window with the text seeded.
 */
export const openInCue = async (text: string): Promise<void> => {
  hideCornerWindow();
  await ensureMainWindowVisible();
  dispatchToMain({ kind: "quickInputSubmit", message: text });
};

let installed = false;

/**
 * Register the corner's IPC surface. Call once from `whenReady`.
 *
 * Note what is absent: nothing here can open the window. The summon is the
 * only opener, and it is bound to the global shortcut — rule 4 is kept by
 * there being no other door rather than by a check.
 */
export const installCornerWindow = (): void => {
  if (installed) return;
  installed = true;

  handle("vellum:corner:getSelection", z.tuple([]), () => pendingSelection);

  handle("vellum:corner:getContext", z.tuple([]), () => ({
    screen: pendingScreen,
    offerScreenReading: pendingOffer,
    consent: screenReadConsent(),
  }));

  // The answer to the invite. Recorded once and honoured: a decline stays
  // declined until the owner changes it themselves.
  handle(
    "vellum:corner:setScreenReading",
    z.tuple([z.boolean()]),
    ([granted]) => {
      setScreenReadConsent(granted);
      pendingOffer = false;
    },
  );

  handle("vellum:corner:hide", z.tuple([]), () => {
    hideCornerWindow();
  });

  handle("vellum:corner:openInCue", z.tuple([z.string()]), async ([text]) => {
    await openInCue(text);
  });
};

/** Test seam — exported only for unit-test setup. */
export const __resetForTesting = (): void => {
  installed = false;
  pendingSelection = null;
  pendingScreen = null;
  pendingOffer = false;
};

/**
 * Re-exported so callers keep importing the corner's gate from the corner.
 * The logic lives in `desktop-surface-flags` — see that file for why.
 */
export { isCornerEnabled };
