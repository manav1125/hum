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
const CUE_LIVE_SUMMON_NOW = "cuelive.summonNow";

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
// Bumped on every summon so a slow daemon guidance response from a previous
// summon can't overwrite the card for a newer one.
let summonGeneration = 0;

/** Daemon route (relative to /v1/assistants/{id}) for synthesized guidance. */
const CUE_LIVE_GUIDANCE_PATH = "/cuelive/guidance";

/**
 * Injected (by `index.ts`) authenticated POST to the local daemon. Kept as a
 * setter rather than a direct import so this module doesn't pull in the
 * host-proxy router (and its native/local-mode deps) — important for unit
 * tests, which inject a fake. Null until wired / outside the desktop app.
 */
type GuidanceFetcher = (path: string, body: unknown) => Promise<unknown>;
let guidanceFetcher: GuidanceFetcher | null = null;
export const setGuidanceFetcher = (fetcher: GuidanceFetcher | null): void => {
  guidanceFetcher = fetcher;
};

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
 * Map an AX role to the verb a user would apply to it, so the hint reads as an
 * action ("Click \"Save\"") rather than a bare label. Covers the common
 * interactive roles; everything else falls back to a neutral "inspect".
 */
const ROLE_ACTIONS: Record<string, string> = {
  AXButton: "Click",
  AXMenuButton: "Open menu",
  AXPopUpButton: "Open menu",
  AXMenuItem: "Choose",
  AXLink: "Open",
  AXCheckBox: "Toggle",
  AXRadioButton: "Select",
  AXTextField: "Type into",
  AXTextArea: "Type into",
  AXSearchField: "Search in",
  AXComboBox: "Pick from",
  AXSlider: "Adjust",
  AXTab: "Switch to",
  AXDisclosureTriangle: "Expand",
};

/**
 * Build the guide-card subtitle from the AX element.
 *
 * Stage 2b turns the raw AX role/label into an action-oriented hint (the verb
 * for the role + the element's label, with the current value for fields). This
 * is a heuristic — no model involved — so it works offline and with any brain,
 * and it's what the card shows INSTANTLY on summon. Stage 3 ({@link
 * requestGuidance}) then asks the daemon to reason a richer "next move" and
 * upgrades the card when it arrives; this heuristic is the guaranteed fallback
 * when there's no model / the call times out / errors.
 */
export const describeNextMove = (element: ReadElementResult): string => {
  const label = element.label?.trim();
  const role = element.role ?? "AXUnknown";
  const action = ROLE_ACTIONS[role];

  if (action) {
    return label ? `${action} "${label}"` : action;
  }
  // Static text / images: surface the content itself when we have it.
  if (role === "AXStaticText" && element.value) {
    return `Text: "${element.value.slice(0, 60)}"`;
  }
  if (label) return label;
  return "Hover an element to inspect it";
};

/** Daemon `cuelive/guidance` response shape. */
const GUIDANCE_SCHEMA = z.object({ nextMove: z.string().nullable() });

/**
 * Ask the assistant daemon to synthesize a contextual "next move" for the
 * element under the cursor (Stage 3). Best-effort: returns null when there is
 * no local assistant, no configured model, or the call fails/times out — the
 * caller keeps the instant heuristic in that case.
 */
const requestGuidance = async (
  element: ReadElementResult,
): Promise<string | null> => {
  if (!guidanceFetcher) return null;
  try {
    const result = await guidanceFetcher(CUE_LIVE_GUIDANCE_PATH, {
      role: element.role ?? "AXUnknown",
      label: element.label,
      value: element.value,
    });
    const parsed = GUIDANCE_SCHEMA.safeParse(result);
    if (!parsed.success) return null;
    return parsed.data.nextMove?.trim() || null;
  } catch (err) {
    log.warn(`[cue-live] guidance request failed: ${errMessage(err)}`);
    return null;
  }
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
  const gen = ++summonGeneration;

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

  // Anchor the card to the element's top-left when available, otherwise the
  // summon cursor position.
  const cardX = element.x ?? cursor.x;
  const cardY = element.y ?? cursor.y;

  // Show the instant heuristic card immediately (Stage 2b) so there's never a
  // wait for the overlay to appear.
  try {
    await client.call(CUE_LIVE_SHOW_CARD, {
      title: "Cue",
      subtitle: describeNextMove(element),
      x: cardX,
      y: cardY,
    });
    log.info(
      `[cue-live] summon: ${role}` +
        `${element.label ? ` "${element.label}"` : ""} → card "${describeNextMove(element)}"` +
        ` @ (${Math.round(cardX)},${Math.round(cardY)})`,
    );
  } catch (err) {
    log.warn(`[cue-live] showCard failed: ${errMessage(err)}`);
  }

  // Auto-dismiss after the linger window if no further summon arrives.
  scheduleHide(client);

  // Stage 3: upgrade the card with the daemon-synthesized "next move" when it
  // lands — unless a newer summon has superseded this one, or it came back
  // empty (no model / error), in which case the heuristic card stands.
  void requestGuidance(element).then((nextMove) => {
    if (!nextMove || gen !== summonGeneration) return;
    client
      .call(CUE_LIVE_SHOW_CARD, {
        title: "Cue",
        subtitle: nextMove,
        x: cardX,
        y: cardY,
      })
      .then(() => {
        log.info(`[cue-live] guidance upgrade → "${nextMove}"`);
        scheduleHide(client);
      })
      .catch((err: unknown) => {
        log.warn(`[cue-live] guidance card update failed: ${errMessage(err)}`);
      });
  });
};

/**
 * Trigger a summon programmatically — the same flow as the Control+Option+Space
 * hotkey — so Cue Live is reachable even when the global key monitor isn't
 * (Accessibility not yet granted, or a flaky grant). Backs the tray menu
 * fallback and the self-test. No-op when Cue Live isn't started.
 */
export const triggerSummon = async (): Promise<void> => {
  if (!started) return;
  try {
    await getMacHelperClient().call(CUE_LIVE_SUMMON_NOW);
  } catch (err) {
    log.warn(`[cue-live] triggerSummon failed: ${errMessage(err)}`);
  }
};

/**
 * One-shot diagnostic (gated on CUE_LIVE_SELFTEST): a few seconds after start,
 * draw a fixed card to prove the overlay renders, then fire a real summon at
 * the cursor to exercise the full read → highlight → card → guidance chain.
 * Everything it does is logged so the chain is verifiable without a keypress.
 */
const runSelfTest = (client: MacHelperClient): void => {
  setTimeout(() => {
    void (async () => {
      log.info(
        "[cue-live] self-test: drawing a fixed card (overlay render check)",
      );
      try {
        await client.call(CUE_LIVE_SHOW_CARD, {
          title: "Cue Live",
          subtitle: "self-test ✓ overlay is rendering",
          x: 200,
          y: 200,
        });
      } catch (err) {
        log.warn(`[cue-live] self-test card failed: ${errMessage(err)}`);
      }
      log.info("[cue-live] self-test: firing a summon at the cursor");
      await triggerSummon();
    })();
  }, 2_500);
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
    if (
      ["1", "true", "yes", "on"].includes(
        (process.env.CUE_LIVE_SELFTEST ?? "").trim().toLowerCase(),
      )
    ) {
      runSelfTest(client);
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
