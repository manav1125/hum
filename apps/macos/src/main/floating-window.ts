import {
  app,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
} from "electron";

import { getRendererBaseProd, getDevRendererBase } from "./app-config";
import { createWindow } from "./windows";

type AlwaysOnTopLevel = NonNullable<
  Parameters<BrowserWindow["setAlwaysOnTop"]>[1]
>;

export type FloatingWindowPosition =
  | { x: number; y: number }
  | ((win: BrowserWindow) => { x: number; y: number });

export interface CreateFloatingWindowOptions {
  kind: string;
  route: string;
  width: number;
  height: number;
  focusOnShow?: boolean;
  alwaysOnTopLevel?: AlwaysOnTopLevel;
  visibleOnAllWorkspaces?: boolean;
  ignoreMouseEvents?: boolean;
  /**
   * Create the window without showing it.
   *
   * For surfaces that cannot know, from main, whether the page they load will
   * render *itself* or something else — the SPA redirects any route to a
   * sign-in or connect screen when it is not ready, and a window shown before
   * that is settled is a sign-in form in a canvas shaped for something else.
   * The caller shows it once the page has said what it is.
   */
  deferShow?: boolean;
  browserWindow?: Omit<
    BrowserWindowConstructorOptions,
    | "webPreferences"
    | "type"
    | "width"
    | "height"
    | "frame"
    | "transparent"
    | "resizable"
    | "skipTaskbar"
    | "fullscreenable"
    | "show"
  >;
  position?: FloatingWindowPosition;
}

const floatingWindows = new Map<string, BrowserWindow>();

const floatingWindowUrl = (route: string): string => {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  const base = app.isPackaged ? getRendererBaseProd() : getDevRendererBase();
  return `${base}${normalizedRoute}`;
};

const isAlive = (win: BrowserWindow): boolean =>
  !win.isDestroyed() && !win.webContents.isDestroyed();

/** Show a window that was created with `deferShow`. */
export const revealFloatingWindow = (
  kind: string,
  focusOnShow = false,
): void => {
  const win = getFloatingWindow(kind);
  if (!win || win.isVisible()) return;
  showFloatingWindow(win, focusOnShow);
};

export const getFloatingWindow = (kind: string): BrowserWindow | null => {
  const win = floatingWindows.get(kind);
  if (!win) return null;
  if (isAlive(win)) return win;
  floatingWindows.delete(kind);
  return null;
};

const applyPosition = (
  win: BrowserWindow,
  position: FloatingWindowPosition | undefined,
): void => {
  if (!position) return;
  const { x, y } = typeof position === "function" ? position(win) : position;
  win.setPosition(x, y);
};

const showFloatingWindow = (
  win: BrowserWindow,
  focusOnShow: boolean,
): void => {
  if (focusOnShow) {
    win.show();
    win.focus();
    return;
  }
  win.showInactive();
};

export const createFloatingWindow = ({
  kind,
  route,
  width,
  height,
  focusOnShow = false,
  alwaysOnTopLevel = "floating",
  visibleOnAllWorkspaces = true,
  ignoreMouseEvents = false,
  deferShow = false,
  browserWindow,
  position,
}: CreateFloatingWindowOptions): BrowserWindow => {
  const existing = getFloatingWindow(kind);
  if (existing) {
    applyPosition(existing, position);
    if (!deferShow) showFloatingWindow(existing, focusOnShow);
    return existing;
  }

  const win = createWindow({
    browserWindow: {
      ...browserWindow,
      type: "panel",
      width,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
    },
    navigation: "deny-all",
  });

  win.setAlwaysOnTop(true, alwaysOnTopLevel);
  if (ignoreMouseEvents) {
    win.setIgnoreMouseEvents(true);
  }
  if (visibleOnAllWorkspaces) {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }

  const cleanup = (): void => {
    if (floatingWindows.get(kind) === win) {
      floatingWindows.delete(kind);
    }
  };
  win.on("closed", cleanup);
  win.webContents.on("destroyed", cleanup);

  floatingWindows.set(kind, win);
  applyPosition(win, position);
  void win.loadURL(floatingWindowUrl(route));
  if (!deferShow) showFloatingWindow(win, focusOnShow);
  return win;
};
