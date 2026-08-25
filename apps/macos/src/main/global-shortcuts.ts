import { app, globalShortcut } from "electron";

import { GLOBAL_SHORTCUT_DEFAULTS } from "./commands";
import log from "./logger";
import {
  isCompanionEnabled,
  summonCompanionCard,
} from "./companion-window";
import { isCornerEnabled, summonCorner } from "./corner-window";
import { ensureVisible } from "./main-window";
import { toggleQuickInput } from "./quick-input-window";
import { onSettingChange, readHotkeyOverride } from "./settings";

/**
 * Resolve the accelerator for a global shortcut key, preferring the user
 * override from `settings.hotkeys.<key>` over the compiled default. An explicit
 * empty-string override means the user disabled the shortcut, so it resolves to
 * `""` and `registerAll` skips registering it.
 */
const resolveGlobalAccelerator = (key: string): string => {
  return readHotkeyOverride(key) ?? GLOBAL_SHORTCUT_DEFAULTS[key] ?? "";
};

/**
 * Track the last successfully registered accelerator for each global
 * shortcut key so re-registration on settings change can unregister the
 * previous binding before registering the new one.
 */
const registered = new Map<string, string>();

/**
 * Unregister all currently held global shortcuts so the next
 * `registerAll` pass starts from a clean slate. Without this,
 * swapping two shortcuts (e.g. globalHotkey ↔ quickInput) would
 * fail: the first `register` call would try to claim an accelerator
 * still held by the second key and Electron would reject it.
 */
const unregisterAll = (): void => {
  for (const [, accelerator] of registered) {
    globalShortcut.unregister(accelerator);
  }
  registered.clear();
};

const registerAll = (): void => {
  unregisterAll();
  for (const key of Object.keys(GLOBAL_SHORTCUT_DEFAULTS)) {
    const accelerator = resolveGlobalAccelerator(key);
    if (!accelerator) {
      continue;
    }

    // The corner claims `⌥C` system-wide, and `⌥C` types `ç` in every app
    // that does not have it bound. Registering that for someone who has not
    // switched the feature on would take a character away from them, so the
    // binding follows the flag rather than merely the window.
    if (key === "cornerSummon" && !isCornerEnabled()) {
      continue;
    }

    // The companion's summon follows its own flag for the same reason: it
    // claims `⌥Space` system-wide, which is a non-breaking space in several
    // apps, and taking that from someone who has not switched the companion
    // on would be taking a character away for nothing.
    if (key === "companionSummon" && !isCompanionEnabled()) {
      continue;
    }

    const handler = HANDLERS[key];
    if (!handler) {
      continue;
    }

    const ok = globalShortcut.register(accelerator, handler);
    if (ok) {
      registered.set(key, accelerator);
      log.info(`[global-shortcuts] registered ${key} → ${accelerator}`);
    } else {
      log.warn(
        `[global-shortcuts] failed to register ${key} → ${accelerator} (possibly held by another app)`,
      );
    }
  }
};

const HANDLERS: Record<string, () => void> = {
  globalHotkey: () => {
    void ensureVisible();
  },
  quickInput: () => {
    toggleQuickInput();
  },
  // The corner's single summon. It reads the selection before it shows, so
  // the handler is async — fire-and-forget is right here: a global shortcut
  // has nobody to report to.
  cornerSummon: () => {
    void summonCorner();
  },
  // `C12`: every creature action has a key, so the pointer is never the only
  // path to it. The card opens where the creature already is.
  companionSummon: () => {
    summonCompanionCard();
  },
};

let teardown: (() => void) | null = null;

/**
 * Register system-wide global shortcuts and subscribe to settings changes
 * so re-binding is immediate. Call once from `app.whenReady()`.
 */
export const installGlobalShortcuts = (): void => {
  if (teardown) return;

  registerAll();

  const unsubscribe = onSettingChange("hotkeys", () => {
    registerAll();
  });
  // Flag flips have to reach the registration too, or turning the corner on
  // would leave its summon dead until the next launch.
  const unsubscribeFlags = onSettingChange("featureFlags", () => {
    registerAll();
  });

  const onQuit = (): void => {
    unregisterAll();
  };
  app.on("will-quit", onQuit);

  teardown = () => {
    unsubscribe();
    unsubscribeFlags();
    app.off("will-quit", onQuit);
    onQuit();
  };
};
