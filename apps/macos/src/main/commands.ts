import { BrowserWindow } from "electron";

import type { VellumCommand } from "@vellumai/ipc-contract";

import { readHotkeyOverride } from "./settings";

export type { VellumCommand };

export type VellumCommandKind = VellumCommand["kind"];

/**
 * Default accelerators per command, matching the Swift app's
 * `UserDefaults` defaults from
 * `clients/macos/vellum-assistant/App/AppDelegate+MenuBar.swift`.
 *
 * Populated lazily at menu-build time by merging with `settings.hotkeys`
 * (rather than via the electron-store schema `default` block, which would
 * clobber user overrides on schema migration).
 */
export const DEFAULT_ACCELERATORS: Record<VellumCommandKind, string> = {
  newConversation: "CmdOrCtrl+N",
  // The companion's menu item, not a keyboard command: `⌥␣` is the creature's
  // own key family (`C12`) and is registered as a global shortcut, not here.
  newNote: "",
  // Companion-originated, never keyboard commands.
  nudgeDismissed: "",
  openNeedsYouItem: "",
  stopCapture: "",
  handleDrop: "",
  currentConversation: "CmdOrCtrl+Shift+N",
  markCurrentUnread: "CmdOrCtrl+Shift+U",
  openSettings: "CmdOrCtrl+,",
  shareFeedback: "",
  /**
   * ⌘F is NOT bound, and this is the line that matters.
   *
   * A menu accelerator is registered in the main process and is consumed by
   * Electron before the key ever reaches the renderer, so removing the
   * renderer's `find` handler alone would have changed nothing: ⌘F would still
   * have been swallowed, and would then have done nothing at all — worse than
   * the bug it was meant to fix. Unbinding it here is what hands the key back.
   *
   * Design's rule (v8 W1): "`/` or ⌘K; ⌘F is never intercepted. Find-in-page is
   * a reflex older than the app." `acceleratorOption` turns an empty string
   * into no `accelerator` key at all, so the Edit ▸ Find… item stays clickable
   * and simply carries no chord. The palette's own openers are `/` and ⌘K.
   */
  find: "",
  markAllRead: "",
  logout: "",
  rePair: "",
  sidebarToggle: "CmdOrCtrl+\\",
  home: "CmdOrCtrl+Shift+H",
  popOut: "CmdOrCtrl+P",
  previousConversation: "CmdOrCtrl+Up",
  nextConversation: "CmdOrCtrl+Down",
  commandPalette: "CmdOrCtrl+K",
  openConversation: "",
  openLibrary: "",
  openIdentity: "",
  openCueLive: "",
  navigateBack: "",
  navigateForward: "",
  zoomIn: "",
  zoomOut: "",
  actualSize: "",
  selectAssistant: "",
  createAssistant: "",
  retireAssistant: "",
  quickInputSubmit: "",
  cancelActiveAction: "",
  cancelDictation: "",
  replayOnboarding: "",
  previewPrechat: "",
  replayHatchFailure: "",
  openComponentGallery: "",
  openVoice: "",
};

/**
 * Commands whose accelerators are registered as Electron `globalShortcut`s
 * (system-wide, active even when the app is not focused). Every other
 * command uses menu accelerators which only fire when the app has focus.
 */
export const GLOBAL_SHORTCUT_DEFAULTS: Record<string, string> = {
  globalHotkey: "CmdOrCtrl+Shift+G",
  quickInput: "CmdOrCtrl+Shift+/",
  // The floating corner. `⌥C` rather than the `⌥Space` the design asked for:
  // Cue Live's summon is `⌃⌥Space`, and two summons one modifier apart means
  // a slipped finger starts a continuous watching session instead of opening
  // a panel — the exact drift the corner must never make. Owner decision,
  // 2026-08-20: move the new thing, leave the shipped one alone.
  //
  // `⌥C` types `ç` when it is not registered, which is why this binding is
  // rebindable from day one (`HOTKEY_CATALOG` in `hotkeys.ts`).
  cornerSummon: "Alt+C",
  /**
   * The always-on companion's summon — `⌥Space`, design `C12`.
   *
   * **This supersedes the 2026-08-20 decision above** (owner, 2026-08-25:
   * "C12 you decide and let this take precedent; Cue Live still needs work
   * anyway"). Two things make it safe now that were not true then:
   *
   *   · The corner retires as a surface, so this is not a third summon added
   *     beside two others — it replaces `⌥C`, which retires with it.
   *   · `⌃⌥Space` is not registered anywhere in this codebase. Cue Live is
   *     summoned over IPC (`vellum:cueLive:summon`), so the adjacency that
   *     decision was protecting against is not currently live. **If Cue Live
   *     ever registers `⌃⌥Space` as a global shortcut, it has to move** — a
   *     slipped finger must not start a continuous watching session.
   *
   * Rebindable like the corner's, and for a better reason: `⌥Space` is a
   * non-breaking space in several apps.
   */
  companionSummon: "Alt+Space",
};

/**
 * Resolve the accelerator for a command, preferring the user override from
 * `settings.hotkeys.<kind>` and falling back to the compiled default when no
 * override is set. An explicit empty-string override is honored as "disabled"
 * (the user removed the binding via the Keyboard Shortcuts settings) — callers
 * that build menu items must treat an empty result as "no accelerator".
 */
export const resolveAccelerator = (kind: VellumCommandKind): string => {
  return readHotkeyOverride(kind) ?? DEFAULT_ACCELERATORS[kind];
};

/**
 * Menu/tray template fragment carrying a command's accelerator, or no
 * `accelerator` key at all when the binding is disabled (an empty-string
 * override, or a command with no compiled default). Electron treats a missing
 * `accelerator` as "no shortcut", whereas `accelerator: ""` is not a valid
 * accelerator — passing it to `Menu.buildFromTemplate` throws. Every menu and
 * tray item builds its accelerator through this helper so the empty-string
 * case is handled in exactly one place.
 */
export const acceleratorOption = (
  kind: VellumCommandKind,
): { accelerator?: string } => {
  const accelerator = resolveAccelerator(kind);
  return accelerator ? { accelerator } : {};
};

/**
 * Send a command to whichever BrowserWindow currently has focus, falling
 * back to the first window if none is focused (which happens when a menu
 * item is clicked from the menu bar while the app is in the background but
 * its window isn't the OS focus owner). Capturing a window reference at
 * menu-construction time would break future thread pop-outs, where the
 * user expects Cmd+N to operate on the popped-out window they're in.
 */
export const dispatchToFocused = (command: VellumCommand): void => {
  const target =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  target?.webContents.send("vellum:command", command);
};
