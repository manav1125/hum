import { screen, type BrowserWindow } from "electron";
import { z } from "zod";

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle } from "./ipc";
import {
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
} from "./main-window";
import { onSettingChange, readSetting, writeSetting } from "./settings";
import { getStatus, onStatusChange } from "./status";
import { restoreBounds, track as trackWindowState } from "./window-state";
import { isCompanionEnabled } from "./desktop-surface-flags";

/**
 * Floating desktop companion (slice 1) — an always-on-top, frameless,
 * non-activating corner orb, modeled on upstream's native macOS companion
 * program but built as an Electron panel window hosting the SPA's
 * `/assistant/floating/companion` route (the same shell-over-web shape as
 * the command palette and dictation overlay).
 *
 * Behavior:
 *   - Gated by the `desktop-companion` client feature flag (registry:
 *     `meta/feature-flags/feature-flag-registry.json`, DEFAULT OFF). The
 *     renderer publishes flag values over `vellum:featureFlags:set`
 *     (persisted by `settings.ts`), and `VELLUM_FLAG_DESKTOP_COMPANION`
 *     force-overrides in either direction — mirroring the renderer's
 *     `VELLUM_FLAG_*` env activation pattern. Flag off ⇒ zero footprint:
 *     no window, no tray items (the tray gates on `isCompanionEnabled`).
 *   - Show/hide is a persisted user choice (`companionVisible`), toggled
 *     from the tray's "Show/Hide Cue Companion" item.
 *   - The window is a `type: "panel"` (non-activating) singleton pinned to
 *     the bottom-right corner by default, draggable via CSS drag regions in
 *     the renderer, visible on all workspaces, with its collapsed position
 *     persisted under the `companion` window-state key.
 *   - The renderer asks main to resize between the collapsed orb and the
 *     expanded mini card (`vellum:companion:setExpanded`); the resize keeps
 *     the orb's bottom-right corner anchored so a corner-pinned companion
 *     expands inward instead of off-screen.
 *   - Status: main already owns the tray's `AssistantStatus` state machine
 *     (renderer-published via `vellum:status:connection`), so the companion
 *     reuses it — pushed over `vellum:companion:status`, pulled once via
 *     `vellum:companion:getStatus` — rather than running its own polling.
 */

const COMPANION_KIND = "companion";
const COMPANION_PATH = "/floating/companion";

export const COMPANION_COLLAPSED_SIZE = { width: 72, height: 72 } as const;
export const COMPANION_EXPANDED_SIZE = { width: 260, height: 148 } as const;

/** Margin from the work-area corner for the first-run default position. */
const DEFAULT_CORNER_MARGIN = 24;

const COMPANION_FLAG_KEY = "desktop-companion";
const COMPANION_FLAG_ENV = "VELLUM_FLAG_DESKTOP_COMPANION";

const ENV_TRUE = new Set(["true", "1", "yes", "on"]);
const ENV_FALSE = new Set(["false", "0", "no", "off"]);

/**
 * `VELLUM_FLAG_DESKTOP_COMPANION` override: `true`/`false` when the env var
 * parses as a boolean, `null` when unset or unparseable (fall through to the
 * renderer-published flag map). Same token set as the preload's
 * `__VELLUM_FLAG_OVERRIDES__` parser so one env var drives both processes.
 */
const envFlagOverride = (): boolean | null => {
  const raw = process.env[COMPANION_FLAG_ENV]?.trim().toLowerCase();
  if (!raw) return null;
  if (ENV_TRUE.has(raw)) return true;
  if (ENV_FALSE.has(raw)) return false;
  return null;
};

/**
 * Whether the desktop-companion feature flag is currently enabled. Checked
 * at tray-menu-build time and on every sync so toggling the flag takes
 * effect without an app restart (matching the tray's other flag gates).
 */
/**
 * The persisted show/hide choice. Defaults to visible so enabling the flag
 * is sufficient to see the companion; hiding from the tray (or the window's
 * own hide action) persists until the user shows it again.
 */
export const isCompanionVisible = (): boolean =>
  readSetting("companionVisible") ?? true;

// Whether the singleton window is currently showing the expanded mini card.
// Presentation state only — deliberately not persisted; a fresh window always
// opens collapsed.
let expanded = false;

const companionWindow = (): BrowserWindow | null =>
  getFloatingWindow(COMPANION_KIND);

/**
 * First-run default: bottom-right corner of the primary display's work
 * area, inset by a margin. Once the user drags the orb, the persisted
 * `companion` window-state entry wins (see `openCompanionWindow`).
 */
const defaultCornerPosition = (): { x: number; y: number } => {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return {
    x: x + width - COMPANION_COLLAPSED_SIZE.width - DEFAULT_CORNER_MARGIN,
    y: y + height - COMPANION_COLLAPSED_SIZE.height - DEFAULT_CORNER_MARGIN,
  };
};

const pushStatusTo = (win: BrowserWindow): void => {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send("vellum:companion:status", getStatus());
};

const openCompanionWindow = (): BrowserWindow => {
  const existing = companionWindow();
  if (existing) return existing;

  expanded = false;

  // Saved collapsed position (clamped to a live display by `restoreBounds`);
  // fall through to the corner default on first run. The restored size is
  // ignored in favor of the collapsed constants — persistence is gated to
  // the collapsed state, so they only disagree after a crash mid-expand.
  const restored = restoreBounds(COMPANION_KIND, COMPANION_COLLAPSED_SIZE);
  const position =
    restored.x !== undefined && restored.y !== undefined
      ? { x: restored.x, y: restored.y }
      : defaultCornerPosition();

  const win = createFloatingWindow({
    kind: COMPANION_KIND,
    route: COMPANION_PATH,
    width: COMPANION_COLLAPSED_SIZE.width,
    height: COMPANION_COLLAPSED_SIZE.height,
    // Non-activating: the orb must never steal focus from the app the user
    // is working in. Click actions surface the main window explicitly.
    focusOnShow: false,
    alwaysOnTopLevel: "floating",
    visibleOnAllWorkspaces: true,
    position,
    browserWindow: {
      movable: true,
      minimizable: false,
      maximizable: false,
      // The page paints the orb on a fully transparent canvas; a native
      // shadow would draw a rectangular halo around it.
      hasShadow: false,
      backgroundColor: "#00000000",
    },
  });

  // Persist the collapsed position (debounced move + close) under its own
  // window-state key. Gated on collapsed so the expanded card's transient
  // geometry is never saved as the orb's home.
  trackWindowState(COMPANION_KIND, win, () => !expanded);

  // The route chunk loads lazily; push the current status once the renderer
  // is ready so the orb doesn't wait for the next transition.
  win.webContents.on("did-finish-load", () => {
    pushStatusTo(win);
  });

  win.on("closed", () => {
    expanded = false;
  });

  return win;
};

/**
 * Resize the companion between the collapsed orb and the expanded mini
 * card, keeping the bottom-right corner anchored (the default home is the
 * bottom-right of the display, so growing up-left keeps the card on
 * screen) and clamping into the current display's work area. The window is
 * constructed non-user-resizable; the temporary `setResizable(true)` dance
 * is the documented workaround for programmatic resizes of fixed-size
 * windows.
 */
export const setCompanionExpanded = (value: boolean): void => {
  const win = companionWindow();
  if (!win) return;
  if (expanded === value) return;
  expanded = value;

  const bounds = win.getBounds();
  const target = value ? COMPANION_EXPANDED_SIZE : COMPANION_COLLAPSED_SIZE;
  const workArea = screen.getDisplayMatching(bounds).workArea;

  let x = bounds.x + bounds.width - target.width;
  let y = bounds.y + bounds.height - target.height;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - target.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - target.height));

  win.setResizable(true);
  win.setBounds({ x, y, width: target.width, height: target.height });
  win.setResizable(false);
};

/**
 * Reconcile the window with the flag + visibility settings: open it when
 * the companion should be on screen, close it when it should not. Safe to
 * call repeatedly; the underlying window is a singleton.
 */
export const syncCompanionWindow = (): void => {
  const shouldShow = isCompanionEnabled() && isCompanionVisible();
  const existing = companionWindow();
  if (shouldShow && !existing) {
    openCompanionWindow();
    return;
  }
  if (!shouldShow && existing) {
    existing.close();
  }
};

/**
 * Tray "Show/Hide Cue Companion": flip the persisted visibility choice and
 * reconcile. (The flag itself is not touched — a hidden companion with the
 * flag on stays one tray click away.)
 */
export const toggleCompanionWindow = (): void => {
  writeSetting("companionVisible", !isCompanionVisible());
  syncCompanionWindow();
};

/**
 * "Talk to Cue" (tray item and the companion card's Talk action): surface
 * the main window — recreating it if the user closed it — then dispatch the
 * `openVoice` command, which the renderer routes to the voice surface.
 * Awaiting `ensureVisible` matters: it resolves only after the renderer has
 * finished loading, so the command isn't dropped by a freshly created
 * window.
 */
export const talkToCue = async (): Promise<void> => {
  // Collapse first so the mini card isn't left floating over the main
  // window the user is being sent to.
  setCompanionExpanded(false);
  await ensureMainWindowVisible();
  dispatchToMain({ kind: "openVoice" });
};

/**
 * "Open Cue": surface (or recreate) the main window.
 */
export const openCueFromCompanion = async (): Promise<void> => {
  setCompanionExpanded(false);
  await ensureMainWindowVisible();
};

let installed = false;

/**
 * Register the companion IPC surface and reconcile the window with the
 * persisted flag state. Call once from `whenReady` (after
 * `installStatusIpc`, so status pushes reflect renderer publishes).
 * Idempotent under dev hot-reload like the other `installX` modules.
 *
 * With the flag off this is inert beyond channel registration: no window
 * is created, and the handlers no-op against the absent singleton.
 */
export const installCompanionWindow = (): void => {
  if (installed) return;
  installed = true;

  handle(
    "vellum:companion:setExpanded",
    z.tuple([z.boolean()]),
    ([value]) => {
      setCompanionExpanded(value);
    },
  );

  handle("vellum:companion:talk", z.tuple([]), async () => {
    await talkToCue();
  });

  handle("vellum:companion:openCue", z.tuple([]), async () => {
    await openCueFromCompanion();
  });

  handle("vellum:companion:hide", z.tuple([]), () => {
    writeSetting("companionVisible", false);
    syncCompanionWindow();
  });

  handle("vellum:companion:getStatus", z.tuple([]), () => getStatus());

  // Mirror tray-style status reactivity: push transitions to the companion
  // renderer so the orb tracks idle/thinking without polling.
  onStatusChange(() => {
    const win = companionWindow();
    if (win) pushStatusTo(win);
  });

  // The renderer publishes flag values after sign-in / flag toggles; the
  // persisted map is also available at startup from the previous session.
  // Reconcile now and on every change so flipping the flag (or the
  // visibility choice being rewritten elsewhere) takes effect live.
  onSettingChange("featureFlags", () => {
    syncCompanionWindow();
  });
  syncCompanionWindow();
};

// Test seam — exported only for unit-test setup. Production code uses
// `installCompanionWindow` instead.
export const __resetForTesting = (): void => {
  installed = false;
  expanded = false;
};

/**
 * Re-exported so the tray keeps importing its gate from the window it gates.
 * The logic itself lives in `desktop-surface-flags` — see that file for why.
 */
export { isCompanionEnabled };
