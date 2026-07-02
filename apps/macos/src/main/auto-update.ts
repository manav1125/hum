import { autoUpdater } from "electron-updater";
import { app, BrowserWindow } from "electron";
import { z } from "zod";

import type { UpdateState, UpdateStatus } from "@vellumai/ipc-contract";

import { handle } from "./ipc";
import log from "./logger";

declare const __VELLUM_ENVIRONMENT__: string;

const ENVIRONMENT: string =
  typeof __VELLUM_ENVIRONMENT__ === "string"
    ? __VELLUM_ENVIRONMENT__
    : "production";

/**
 * Update feed for Cue.
 *
 * Default: the GitHub Releases feed baked into the build by electron-builder
 * (`publish` in electron-builder.config.cjs → app-update.yml inside the app;
 * electron-updater reads it automatically, no setFeedURL needed). The releases
 * repo is public, so no token is required at runtime.
 *
 * Overrides:
 *  - CUE_UPDATE_FEED_URL: point at a generic-provider feed instead (e.g. a
 *    static dir on the Render service). Also the only way to enable updates
 *    for dev/staging side-by-side builds.
 *  - CUE_AUTO_UPDATE=0: kill switch — disables the updater entirely.
 *
 * The default feed is only wired for `production`/`local` environments (both
 * ship as plain "Cue"); `dev`/`staging` builds share the version line, so
 * pointing them at the release feed would "update" them onto the production
 * artifact.
 */
const CUE_UPDATE_FEED_URL = process.env.CUE_UPDATE_FEED_URL?.trim();
const AUTO_UPDATE_DISABLED = ["0", "false", "off"].includes(
  (process.env.CUE_AUTO_UPDATE ?? "").trim().toLowerCase(),
);
const DEFAULT_FEED_ENVIRONMENTS = new Set(["production", "local"]);
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type { UpdateState, UpdateStatus };

let currentState: UpdateState = { status: "idle" };

const setState = (next: UpdateState): void => {
  currentState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("vellum:update:state", currentState);
    }
  }
};

export const checkForUpdates = (): void => {
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    log.error("[auto-update] checkForUpdates failed:", err);
  });
};

export const installAutoUpdate = (): void => {
  handle("vellum:update:getState", z.tuple([]), () => currentState);
  handle("vellum:update:check", z.tuple([]), () => checkForUpdates());
  handle("vellum:update:install", z.tuple([]), () =>
    autoUpdater.quitAndInstall(),
  );

  // Updater only makes sense (and only works) on packaged builds — dev runs
  // have no app-update.yml and nothing installable. IPC handlers above stay
  // registered either way so the renderer's update UI just sees "idle".
  if (!app.isPackaged) return;

  if (AUTO_UPDATE_DISABLED) {
    log.info("[auto-update] disabled via CUE_AUTO_UPDATE");
    return;
  }

  if (!CUE_UPDATE_FEED_URL && !DEFAULT_FEED_ENVIRONMENTS.has(ENVIRONMENT)) {
    log.info(
      `[auto-update] disabled for "${ENVIRONMENT}" builds — set CUE_UPDATE_FEED_URL to opt in`,
    );
    return;
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  if (CUE_UPDATE_FEED_URL) {
    // Explicit generic feed override. Generic feeds are channel-addressed
    // ({channel}-mac.yml), so keep the environment-named channel here.
    autoUpdater.channel = ENVIRONMENT;
    autoUpdater.setFeedURL({ provider: "generic", url: CUE_UPDATE_FEED_URL });
    log.info(`[auto-update] using generic feed override: ${CUE_UPDATE_FEED_URL}`);
  } else {
    // Default: GitHub Releases feed from the baked-in app-update.yml. Do NOT
    // set a channel — the GitHub provider publishes latest-mac.yml only, and a
    // custom channel would make the updater look for production-mac.yml that
    // never exists.
    log.info("[auto-update] using GitHub Releases feed from app-update.yml");
  }

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    setState({ status: "available", version: info.version });
  });

  autoUpdater.on("download-progress", (progressObj) => {
    setState({
      status: "downloading",
      progress: {
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    log.error("[auto-update] error:", err);
    setState({ status: "error", error: err.message });
  });

  autoUpdater.on("update-not-available", () => {
    setState({ status: "idle" });
  });

  // Check on launch, then every 4 hours. The app-menu "Check for Updates…"
  // item (src/main/menu.ts) triggers the same checkForUpdates on demand.
  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
};
