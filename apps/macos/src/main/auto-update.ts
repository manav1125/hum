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
 * Update feed for Cue. Cue has no release channel of its own yet, so the
 * auto-updater is OFF by default: the previous hard-coded default pointed at
 * the upstream vellum-ai releases bucket, which spammed the log with signature
 * failures every launch and — worse — could have replaced the Cue app with an
 * unrelated upstream Vellum build if a signature ever matched. Set
 * CUE_UPDATE_FEED_URL (a full generic-provider URL) to opt back in once Cue
 * publishes its own signed builds.
 */
const CUE_UPDATE_FEED_URL = process.env.CUE_UPDATE_FEED_URL?.trim();

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

  if (!app.isPackaged) return;

  // No Cue release channel configured → don't wire the updater at all. Keeps
  // the IPC handlers above (the renderer's update UI just sees "idle"), but no
  // network checks, no log noise, and no risk of pulling the upstream build.
  if (!CUE_UPDATE_FEED_URL) {
    log.info("[auto-update] disabled — no CUE_UPDATE_FEED_URL configured");
    return;
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.channel = ENVIRONMENT;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: "generic", url: CUE_UPDATE_FEED_URL });

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

  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
};
