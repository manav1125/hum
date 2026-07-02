/**
 * Remote push registration for the Capacitor mobile shell.
 *
 * On iOS/Android the SPA runs inside a Capacitor webview whose JS runtime
 * is suspended when the app is backgrounded, so SSE-driven local
 * notifications (runtime/notifications.ts) stop firing. This module closes
 * that gap: it requests notification permission, obtains the device's
 * APNs/FCM token via `@capacitor/push-notifications`, and registers the
 * token with the daemon's push-device registry (`POST /push-devices`).
 * The daemon then delivers pushes directly through APNs when background
 * work completes or an approval is needed — no live connection required.
 *
 * No-op on desktop browsers and Electron (`Capacitor.isNativePlatform()`
 * is false there). Safe to call repeatedly — listeners are registered
 * once and token registration is deduped per (assistantId, token).
 *
 * The native side is already wired: apps/ios AppDelegate forwards the APNs
 * token via `.capacitorDidRegisterForRemoteNotifications`, Info.plist has
 * the `remote-notification` background mode, and App.entitlements carries
 * `aps-environment`.
 */

import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

import { pushdevicesPost } from "@/generated/daemon/sdk.gen";

let listenersRegistered = false;
let currentAssistantId: string | null = null;
/** Last successfully registered (assistantId, token) pair — dedupes re-posts. */
let lastRegisteredKey: string | null = null;

function deviceNameGuess(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("iPhone")) return "iPhone";
  if (Capacitor.getPlatform() === "android") return "Android device";
  return "Mobile device";
}

async function registerTokenWithDaemon(token: string): Promise<void> {
  const assistantId = currentAssistantId;
  if (!assistantId || !token) return;
  const key = `${assistantId}:${token}`;
  if (key === lastRegisteredKey) return;

  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") return;

  try {
    const { error } = await pushdevicesPost({
      path: { assistant_id: assistantId },
      body: {
        platform,
        token,
        deviceName: deviceNameGuess(),
      },
      throwOnError: false,
    });
    if (!error) {
      lastRegisteredKey = key;
    }
  } catch {
    // Best-effort: a failed registration means no remote push until the
    // next app launch retries. Never surface this to the user.
  }
}

async function ensureListeners(): Promise<void> {
  if (listenersRegistered) return;
  listenersRegistered = true;

  // iOS rotates tokens across reinstalls/OS restores; the listener fires
  // on every `register()` call, so each launch re-syncs the daemon.
  await PushNotifications.addListener("registration", (token) => {
    void registerTokenWithDaemon(token.value);
  });
  await PushNotifications.addListener("registrationError", (err) => {
    // Actionable during development (missing entitlement / provisioning),
    // invisible noise for users — log to the console only.
    console.warn("[push-notifications] APNs registration failed", err);
  });
}

/**
 * Register this device for remote push. Call whenever the active assistant
 * is resolved (e.g. from the root layout) — repeat calls are cheap.
 */
export async function initPushNotifications(
  assistantId: string,
): Promise<void> {
  if (typeof window === "undefined") return;
  if (!Capacitor.isNativePlatform()) return;

  currentAssistantId = assistantId;

  try {
    let { receive } = await PushNotifications.checkPermissions();
    if (receive === "prompt" || receive === "prompt-with-rationale") {
      ({ receive } = await PushNotifications.requestPermissions());
    }
    if (receive !== "granted") return;

    await ensureListeners();
    await PushNotifications.register();
  } catch (err) {
    // Plugin unavailable (older shell build) or OS-level failure — remote
    // push silently stays off; local notifications still work in-app.
    console.warn("[push-notifications] init failed", err);
  }
}
