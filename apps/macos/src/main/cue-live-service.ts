import { z } from "zod";

import { getMacHelperClient, type MacHelperClient } from "./hotkey-helper";
import log from "./logger";

/**
 * Cue Live — Stage 2 orchestration.
 *
 * The native overlay companion (mac helper, `CueLive.swift`) does the heavy
 * lifting: a borderless always-on-top overlay, a global summon hotkey
 * (Control+Option+Space), and the Accessibility reads/draws. This service is
 * the Electron-main brain that drives it over the existing helper IPC channel:
 * it starts the overlay, listens for summons, reads the element under the
 * cursor, and asks the helper to highlight it and show a guide card.
 *
 * RUNTIME PERMISSION: Cue Live depends on macOS Accessibility permission being
 * granted to the helper at runtime — `readElementAtCursor` returns
 * `{ found: false }` (and highlight/card have nothing to anchor to) until the
 * user grants it in System Settings › Privacy & Security › Accessibility. The
 * helper owns the prompt; this service degrades gracefully (no card) when the
 * read comes back empty.
 */

// --- Native protocol surface (CueLive.swift) ---------------------------------

const CUE_LIVE_START = "cuelive.start";
const CUE_LIVE_STOP = "cuelive.stop";
const CUE_LIVE_READ_ELEMENT = "cuelive.readElementAtCursor";
const CUE_LIVE_SHOW_CARD = "cuelive.showCard";
const CUE_LIVE_HIGHLIGHT = "cuelive.highlight";
const CUE_LIVE_HIDE = "cuelive.hide";
const CUE_LIVE_SUMMONED = "cuelive.summoned";
const CUE_LIVE_ACCESSIBILITY_TRUSTED = "cuelive.accessibilityTrusted";

/** `cuelive.summoned` notification — cursor position in AX top-left coords. */
const SUMMONED_SCHEMA = z.object({
  x: z.number(),
  y: z.number(),
});

/** `cuelive.accessibilityTrusted` — emitted when the helper observes
 *  Accessibility being granted at runtime and arms the summon hotkey. */
const TRUSTED_SCHEMA = z.object({
  trusted: z.boolean(),
});

/** `cuelive.readElementAtCursor` result — the AX element under the cursor. */
const READ_ELEMENT_SCHEMA = z.object({
  found: z.boolean(),
  role: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

type ReadElementResult = z.infer<typeof READ_ELEMENT_SCHEMA>;

/** `cuelive.start` result. */
const START_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
  // Whether the helper is trusted for Accessibility. The global summon hotkey
  // and the AX element read both require it; when false the overlay never
  // appears on summon. Older helpers omit it.
  accessibilityTrusted: z.boolean().optional(),
});

// --- Gating ------------------------------------------------------------------

/**
 * Cue Live is gated behind the `CUE_LIVE_ENABLED` env var so it does not
 * auto-run for everyone yet (Stage 2 is opt-in). There is no renderer-owned
 * feature flag for a main-process-only, pre-launch capability — the existing
 * `featureFlags` map is published by the renderer for assistant features — so
 * an env toggle is the right seam until Cue Live graduates to a real flag.
 */
export const isCueLiveEnabled = (): boolean =>
  ["1", "true", "yes", "on"].includes(
    (process.env.CUE_LIVE_ENABLED ?? "").trim().toLowerCase(),
  );

/** How long the card/ring linger after the last summon before auto-hiding. */
const AUTO_HIDE_MS = 6_000;

let started = false;
let unsubscribeSummoned: (() => void) | null = null;
let unsubscribeTrusted: (() => void) | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const clearHideTimer = (): void => {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
};

const scheduleHide = (client: MacHelperClient): void => {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    void client.call(CUE_LIVE_HIDE).catch((err: unknown) => {
      log.warn(`[cue-live] hide failed: ${errMessage(err)}`);
    });
  }, AUTO_HIDE_MS);
  hideTimer.unref?.();
};

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Build the guide-card subtitle from the AX element.
 *
 * Stage 2a uses a simple AX-derived hint (the element's label, falling back to
 * its role). The richer "next move" is a deliberate later stage.
 *
 * TODO(cue-live-daemon-synthesis): replace this AX-only hint with a real
 * "next move" synthesized by the assistant daemon. This is the seam where a
 * daemon call goes: pass the element context ({ role, label, value, bounds })
 * to the assistant daemon, await the suggested next action, and use that as
 * the card subtitle (and potentially a richer card body). Until that lands,
 * the AX label/role is the hint we surface.
 */
const describeNextMove = (element: ReadElementResult): string => {
  const hint = element.label ?? element.role ?? "this element";
  return `Next move: ${hint}`;
};

/**
 * On summon: read the element under the cursor, and if found, ring it and show
 * the Cue guide card next to it. Best-effort throughout — a missing element or
 * a transient helper error degrades to "no card", never a crash.
 */
const handleSummon = async (
  client: MacHelperClient,
  cursor: { x: number; y: number },
): Promise<void> => {
  // Each summon resets the linger window; a fresh summon should not be hidden
  // by a timer armed for a previous one.
  clearHideTimer();

  let element: ReadElementResult;
  try {
    const raw = await client.call(CUE_LIVE_READ_ELEMENT);
    const parsed = READ_ELEMENT_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      log.warn("[cue-live] readElementAtCursor returned invalid payload");
      return;
    }
    element = parsed.data;
  } catch (err) {
    log.warn(`[cue-live] readElementAtCursor failed: ${errMessage(err)}`);
    return;
  }

  if (!element.found) {
    // Nothing actionable under the cursor (or Accessibility not yet granted).
    log.info("[cue-live] summon: no AX element under cursor");
    return;
  }

  const role = element.role ?? "AXUnknown";

  // Ring the element bounds when the helper gave us geometry. A mono label of
  // the AX role (e.g. "AXButton") rides along on the ring.
  if (
    element.x !== undefined &&
    element.y !== undefined &&
    element.width !== undefined &&
    element.height !== undefined
  ) {
    try {
      await client.call(CUE_LIVE_HIGHLIGHT, {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        label: role,
      });
    } catch (err) {
      log.warn(`[cue-live] highlight failed: ${errMessage(err)}`);
    }
  }

  // Show the guide card near the cursor. Anchor to the element's top-left when
  // available, otherwise fall back to the summon cursor position.
  try {
    await client.call(CUE_LIVE_SHOW_CARD, {
      title: "Cue",
      subtitle: describeNextMove(element),
      x: element.x ?? cursor.x,
      y: element.y ?? cursor.y,
    });
  } catch (err) {
    log.warn(`[cue-live] showCard failed: ${errMessage(err)}`);
  }

  // Auto-dismiss after the linger window if no further summon arrives.
  scheduleHide(client);
};

/**
 * Start Cue Live: tell the helper to spin up the overlay + summon hotkey, then
 * subscribe to summon notifications. Idempotent.
 */
export const start = async (): Promise<void> => {
  if (started) return;
  started = true;

  const client = getMacHelperClient();

  // Subscribe BEFORE start so a summon that races the overlay coming up is not
  // dropped.
  unsubscribeSummoned = client.onNotification(
    CUE_LIVE_SUMMONED,
    SUMMONED_SCHEMA,
    (cursor) => {
      void handleSummon(client, cursor);
    },
  );

  // The helper arms the summon hotkey the moment Accessibility is granted at
  // runtime (no relaunch needed); surface that transition for diagnosability.
  unsubscribeTrusted = client.onNotification(
    CUE_LIVE_ACCESSIBILITY_TRUSTED,
    TRUSTED_SCHEMA,
    () => {
      log.info(
        "[cue-live] Accessibility granted — summon hotkey is now armed " +
          "(Control+Option+Space).",
      );
    },
  );

  try {
    const raw = await client.call(CUE_LIVE_START);
    const parsed = START_RESULT_SCHEMA.safeParse(raw);
    if (!parsed.success || !parsed.data.enabled) {
      log.warn("[cue-live] cuelive.start did not enable the overlay");
      // Leave the subscription in place; the helper may enable on retry.
      return;
    }
    log.info(
      "[cue-live] overlay started (summon: Control+Option+Space). " +
        "Requires Accessibility permission at runtime.",
    );
    if (parsed.data.accessibilityTrusted === false) {
      log.warn(
        "[cue-live] helper is NOT trusted for Accessibility — the summon " +
          "hotkey and element reads will do nothing until the user enables " +
          "the Cue helper in System Settings → Privacy & Security → " +
          "Accessibility. A system prompt was requested.",
      );
    }
  } catch (err) {
    log.warn(`[cue-live] cuelive.start failed: ${errMessage(err)}`);
  }
};

/** Stop Cue Live: hide UI, tear down the overlay, and drop the subscription. */
export const stop = async (): Promise<void> => {
  if (!started) return;
  started = false;

  clearHideTimer();
  unsubscribeSummoned?.();
  unsubscribeSummoned = null;
  unsubscribeTrusted?.();
  unsubscribeTrusted = null;

  const client = getMacHelperClient();
  try {
    await client.call(CUE_LIVE_STOP);
    log.info("[cue-live] overlay stopped");
  } catch (err) {
    log.warn(`[cue-live] cuelive.stop failed: ${errMessage(err)}`);
  }
};

/**
 * Install Cue Live into the app lifecycle. No-op unless `CUE_LIVE_ENABLED` is
 * set. Call this only when the helper is available (it shares the supervised
 * helper process with the hotkey/dictation services).
 */
export const installCueLive = (): void => {
  if (!isCueLiveEnabled()) {
    log.info("[cue-live] disabled (set CUE_LIVE_ENABLED=1 to enable)");
    return;
  }
  void start();
};

/** Synchronous teardown for app shutdown — drops timers + subscription. */
export const dispose = (): void => {
  started = false;
  clearHideTimer();
  unsubscribeSummoned?.();
  unsubscribeSummoned = null;
  unsubscribeTrusted?.();
  unsubscribeTrusted = null;
};

export const __resetForTesting = (): void => {
  started = false;
  clearHideTimer();
  unsubscribeSummoned?.();
  unsubscribeSummoned = null;
  unsubscribeTrusted?.();
  unsubscribeTrusted = null;
};
