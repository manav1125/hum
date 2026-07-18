/**
 * Thin haptic-feedback wrapper. On native Capacitor platforms this delegates
 * to `@capacitor/haptics`; on web it's a no-op. The plugin is lazily imported
 * the first time a native haptic fires so the Capacitor plugin's
 * `registerPlugin()` call (which throws without the full runtime) never runs in
 * a plain browser context. All methods are fire-and-forget and swallow errors —
 * a missing Taptic Engine or a denied capability must never break a UI action.
 */
import { isNativePlatform } from "@/runtime/native-auth";

// Cached dynamic import of the plugin module, established on first native use.
type HapticsModule = typeof import("@capacitor/haptics");
let modulePromise: Promise<HapticsModule | null> | null = null;

function loadHaptics(): Promise<HapticsModule | null> {
  if (!isNativePlatform()) return Promise.resolve(null);
  if (!modulePromise) {
    modulePromise = import("@capacitor/haptics").catch(() => null);
  }
  return modulePromise;
}

async function impact(style: "Light" | "Medium" | "Heavy"): Promise<void> {
  const mod = await loadHaptics();
  if (!mod) return;
  try {
    await mod.Haptics.impact({ style: mod.ImpactStyle[style] });
  } catch {
    /* Taptic unavailable / denied — never surface to the caller. */
  }
}

async function notify(type: "Success" | "Warning" | "Error"): Promise<void> {
  const mod = await loadHaptics();
  if (!mod) return;
  try {
    await mod.Haptics.notification({ type: mod.NotificationType[type] });
  } catch {
    /* no-op */
  }
}

export const haptic = {
  /** Soft tick — taps, selection changes, card presses. */
  light: () => impact("Light"),
  /** Firmer bump — commit actions (submit, send, open). */
  medium: () => impact("Medium"),
  /** Success notification pattern — a flow completed. */
  success: () => notify("Success"),
  /** Error notification pattern — a flow failed. */
  error: () => notify("Error"),
};
