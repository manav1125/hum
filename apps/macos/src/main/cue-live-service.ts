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
const CUE_LIVE_RUN = "cuelive.run";
const CUE_LIVE_POINT = "cuelive.point";
const CUE_LIVE_ACCESSIBILITY_TRUSTED = "cuelive.accessibilityTrusted";
const CUE_LIVE_SUMMON_NOW = "cuelive.summonNow";
const CUE_LIVE_SUMMON_GOAL = "cuelive.summonGoal";
const CUE_LIVE_CAPTURE_SCREEN = "cuelive.captureScreen";
const CUE_LIVE_POINT_AT = "cuelive.pointAt";
const CUE_LIVE_SET_VOICE_CONFIG = "cuelive.setVoiceConfig";
const CUE_LIVE_SPEAK = "cuelive.speak";
const CUE_LIVE_PERFORM_ACTION = "cuelive.performAction";
const CUE_LIVE_ABORT = "cuelive.abort";
const CUE_LIVE_PERMISSIONS = "cuelive.permissions";
const CUE_LIVE_REQUEST_SCREEN_RECORDING = "cuelive.requestScreenRecording";
const CUE_LIVE_ACT_PATH = "/cuelive/act";

/** `cuelive.summoned` — cursor in AX top-left coords + optional spoken question
 *  (present when the user summoned via push-to-talk). */
const SUMMONED_SCHEMA = z.object({
  x: z.number(),
  y: z.number(),
  question: z.string().optional(),
});

/** `cuelive.run` — the ⌥R push-to-talk key (backlog #29). The helper reports
 *  the cursor (AX top-left coords) and the active capture mode; Electron-main
 *  turns it into a "start Cue Live voice / begin listening" signal to the
 *  renderer. */
const RUN_SCHEMA = z.object({
  x: z.number(),
  y: z.number(),
  captureMode: z.string().optional(),
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
  roleDescription: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  appName: z.string().optional(),
  actions: z.array(z.string()).optional(),
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
 * Resolver for the persisted user toggle. Injected by `index.ts` (which owns
 * the electron-store settings) so this module stays decoupled from persistence
 * and test-isolated — same DI seam as `setGuidanceFetcher`. Defaults to ON so
 * that even before injection (and in the default product build) Cue Live runs.
 */
let persistedEnabledGetter: () => boolean = () => true;

/** Wire the persisted-setting reader. See `persistedEnabledGetter`. */
export const setCueLiveEnabledGetter = (fn: () => boolean): void => {
  persistedEnabledGetter = fn;
};

/**
 * Whether Cue Live should run. Cue Live is ON by default (so the summon hotkey
 * works on a normal double-click launch). Resolution order:
 *   1. `CUE_LIVE_ENABLED` env var, when explicitly set — force on (`1/true/...`)
 *      or off (`0/false/...`). Used by tests and `--no-cue-live` style launches.
 *   2. Otherwise the persisted user setting (via the injected getter), which
 *      itself defaults to ON.
 */
export const isCueLiveEnabled = (): boolean => {
  const env = (process.env.CUE_LIVE_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(env)) return true;
  if (["0", "false", "no", "off"].includes(env)) return false;
  return persistedEnabledGetter();
};

/** How long the card/ring linger after the last summon before auto-hiding. */
const AUTO_HIDE_MS = 6_000;

let started = false;
let unsubscribeSummoned: (() => void) | null = null;
let unsubscribeRun: (() => void) | null = null;
let unsubscribePoint: (() => void) | null = null;
let unsubscribeTrusted: (() => void) | null = null;
let unsubscribeAbort: (() => void) | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped on every summon so a slow daemon guidance response from a previous
// summon can't overwrite the card for a newer one.
let summonGeneration = 0;
// Last Accessibility-trust state the helper reported (from cuelive.start and
// the runtime "trusted" notification). Surfaced to the renderer status page so
// the user can see whether the summon hotkey is actually armed.
let lastKnownTrusted = false;

/** The summon hotkey, for display in the UI. */
export const CUE_LIVE_HOTKEY = "Control+Option+Space";

/** Whether the helper last reported it was trusted for Accessibility. */
export const isAccessibilityTrusted = (): boolean => lastKnownTrusted;

// Last Screen-Recording grant state the helper reported (from cuelive.permissions).
// Surfaced to the renderer so the onboarding banner can block on it too.
let lastKnownScreenRecording = false;

/** `cuelive.permissions` result — the two macOS grants Cue Live depends on. */
const PERMISSIONS_SCHEMA = z.object({
  accessibilityTrusted: z.boolean(),
  screenRecordingGranted: z.boolean(),
});

export interface CueLivePermissions {
  accessibilityTrusted: boolean;
  screenRecordingGranted: boolean;
}

/**
 * Read the live macOS permission grants (Accessibility + Screen Recording)
 * from the helper, non-prompting. Updates the cached trust flags so the status
 * surface stays consistent. Best-effort: returns the last-known state on error
 * (or when Cue Live isn't started yet — the helper isn't reachable then).
 */
export const getPermissions = async (): Promise<CueLivePermissions> => {
  const fallback: CueLivePermissions = {
    accessibilityTrusted: lastKnownTrusted,
    screenRecordingGranted: lastKnownScreenRecording,
  };
  if (!started) return fallback;
  try {
    const raw = await getMacHelperClient().call(CUE_LIVE_PERMISSIONS);
    const parsed = PERMISSIONS_SCHEMA.safeParse(raw);
    if (!parsed.success) return fallback;
    lastKnownTrusted = parsed.data.accessibilityTrusted;
    lastKnownScreenRecording = parsed.data.screenRecordingGranted;
    return parsed.data;
  } catch (err) {
    log.warn(`[cue-live] permissions read failed: ${errMessage(err)}`);
    return fallback;
  }
};

/** `cuelive.requestScreenRecording` result. */
const SCREEN_REQUEST_SCHEMA = z.object({
  granted: z.boolean(),
  prompted: z.boolean(),
});

export interface ScreenRecordingRequestResult {
  granted: boolean;
  /** True when macOS showed the consent prompt (first ask). */
  prompted: boolean;
  /** True when the helper wasn't reachable, so nothing was asked. */
  unavailable?: boolean;
}

/**
 * Ask macOS for Screen Recording. This is what registers Cue in the System
 * Settings ▸ Screen & System Audio Recording list — deep-linking to the pane
 * never does, which is why the row was missing entirely.
 *
 * The request must come from the helper (it owns the capture), and the helper
 * only exists while Cue Live is started — so start it first when it's down,
 * otherwise the ask silently no-ops. Prompting, unlike `getPermissions`.
 */
export const requestScreenRecording =
  async (): Promise<ScreenRecordingRequestResult> => {
    if (!started) {
      try {
        await start();
      } catch (err) {
        log.warn(
          `[cue-live] start for permission ask failed: ${errMessage(err)}`,
        );
        return { granted: false, prompted: false, unavailable: true };
      }
    }
    try {
      const raw = await getMacHelperClient().call(
        CUE_LIVE_REQUEST_SCREEN_RECORDING,
      );
      const parsed = SCREEN_REQUEST_SCHEMA.safeParse(raw);
      if (!parsed.success) {
        return { granted: false, prompted: false, unavailable: true };
      }
      lastKnownScreenRecording = parsed.data.granted;
      return parsed.data;
    } catch (err) {
      log.warn(`[cue-live] screen-recording ask failed: ${errMessage(err)}`);
      return { granted: false, prompted: false, unavailable: true };
    }
  };

/** Last Screen-Recording grant the helper reported (cached, non-prompting). */
export const isScreenRecordingGranted = (): boolean => lastKnownScreenRecording;

/** Whether Cue Live is currently running (overlay up, subscriptions live). */
export const isStarted = (): boolean => started;

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

/**
 * Voice keys provider, injected by `index.ts` so this module stays decoupled
 * from electron-store/safeStorage (same seam as the guidance fetcher). Returns
 * plaintext keys for the helper; null fields mean "not configured".
 */
type VoiceConfig = {
  assemblyAiKey: string | null;
  elevenLabsKey: string | null;
  elevenLabsVoiceId: string | null;
};
let voiceConfigProvider: (() => VoiceConfig) | null = null;
export const setVoiceConfigProvider = (
  fn: (() => VoiceConfig) | null,
): void => {
  voiceConfigProvider = fn;
};

/**
 * Push the current voice keys to the helper. Called on start and whenever the
 * user changes a key. No-op until Cue Live is started and a provider is wired.
 */
export const pushVoiceConfig = async (): Promise<void> => {
  if (!started || !voiceConfigProvider) return;
  const cfg = voiceConfigProvider();
  try {
    await getMacHelperClient().call(CUE_LIVE_SET_VOICE_CONFIG, {
      assemblyAiKey: cfg.assemblyAiKey ?? "",
      elevenLabsKey: cfg.elevenLabsKey ?? "",
      elevenLabsVoiceId: cfg.elevenLabsVoiceId ?? "",
    });
  } catch (err) {
    log.warn(`[cue-live] setVoiceConfig failed: ${errMessage(err)}`);
  }
};

/**
 * The renderer-side "start Cue Live voice / begin listening" dispatcher,
 * injected by `index.ts` (which owns the BrowserWindow → webContents.send
 * plumbing). Kept as a setter — the same DI seam as {@link setGuidanceFetcher}
 * — so this module doesn't import Electron's window machinery and the ⌥R
 * handler is unit-testable with a plain fake. Null until wired / off-desktop.
 */
type StartVoiceDispatcher = () => void;
let startVoiceDispatcher: StartVoiceDispatcher | null = null;
export const setStartVoiceDispatcher = (
  fn: StartVoiceDispatcher | null,
): void => {
  startVoiceDispatcher = fn;
};

/**
 * ⌥R (backlog #29): the helper reports the run hotkey; start Cue Live voice by
 * telling the renderer to begin listening (the `useLiveVoice` flow — the same
 * start the in-app live-voice button triggers).
 *
 * Defensive: no-op unless Cue Live is running AND the helper is trusted for
 * Accessibility (an untrusted helper never actually observed the keypress, and
 * the global monitor is disarmed then anyway). Idempotency / double-start
 * suppression lives in the renderer's live-voice store, which ignores a start
 * while already listening; this handler only guarantees exactly one dispatch
 * per ⌥R press.
 */
export const handleRun = (): void => {
  if (!started) {
    log.info("[cue-live] ⌥R ignored — Cue Live not started");
    return;
  }
  if (!lastKnownTrusted) {
    log.info("[cue-live] ⌥R ignored — helper not trusted for Accessibility");
    return;
  }
  if (!startVoiceDispatcher) {
    log.info("[cue-live] ⌥R received but no start-voice dispatcher wired");
    return;
  }
  log.info("[cue-live] ⌥R — starting Cue Live voice (begin listening)");
  try {
    startVoiceDispatcher();
  } catch (err) {
    log.warn(`[cue-live] start-voice dispatch failed: ${errMessage(err)}`);
  }
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
      roleDescription: element.roleDescription,
      label: element.label,
      value: element.value,
      appName: element.appName,
      actions: element.actions,
    });
    const parsed = GUIDANCE_SCHEMA.safeParse(result);
    if (!parsed.success) return null;
    return parsed.data.nextMove?.trim() || null;
  } catch (err) {
    log.warn(`[cue-live] guidance request failed: ${errMessage(err)}`);
    return null;
  }
};

/** Daemon route for the clicky-style vision ask. */
const CUE_LIVE_LOOK_PATH = "/cuelive/look";

/** Helper `captureScreen` result. */
const CAPTURE_SCHEMA = z.object({
  ok: z.boolean(),
  data: z.string().optional(),
  mediaType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  screenWidth: z.number().optional(),
  screenHeight: z.number().optional(),
  reason: z.string().optional(),
});

/** Daemon `cuelive/look` response: a spoken answer + on-screen points. */
const LOOK_SCHEMA = z.object({
  answer: z.string(),
  points: z.array(
    z.object({ x: z.number(), y: z.number(), label: z.string() }),
  ),
  /** Set when the look failed outright — say it rather than shrug silently. */
  error: z.string().optional(),
});

/** Daemon `cuelive/act` response: the single next action (or done). */
const ACT_SCHEMA = z.object({
  say: z.string().nullable(),
  done: z.boolean(),
  action: z
    .object({
      type: z.enum([
        "click",
        "doubleclick",
        "type",
        "key",
        "scroll",
        "move",
        "none",
      ]),
      x: z.number().nullish(),
      y: z.number().nullish(),
      text: z.string().nullish(),
      key: z.string().nullish(),
      dx: z.number().nullish(),
      dy: z.number().nullish(),
    })
    .nullable(),
});

/**
 * Whether full-auto take-control is enabled (persisted; injected by index.ts).
 * Only voice-initiated summons (a spoken goal) ever trigger it.
 */
let takeControlEnabledGetter: () => boolean = () => true;
export const setTakeControlEnabledGetter = (fn: () => boolean): void => {
  takeControlEnabledGetter = fn;
};

/** Set by the helper's Escape signal to abort an in-progress auto run. */
let abortRequested = false;

/** Max actions per auto run, and the pause between them (UI settle time). */
const MAX_ACT_STEPS = 15;
const ACT_STEP_DELAY_MS = 750;

/** Default question when the user summons without speaking one (pre-voice). */
const DEFAULT_LOOK_QUESTION =
  "What's on my screen right now, and what should I do next?";

/** Fixed question for the ⌥P "point at element" gesture — pointing-focused so
 *  the model returns the element(s) to fly the cursor to, with terse labels. */
const POINT_QUESTION =
  "Point at the element on screen I most likely need to act on next. " +
  "Return the on-screen point(s) with a few-word label each.";

/** At most this many points get pointed at, so a long answer doesn't drag. */
const MAX_POINTS = 5;
/** Dwell on each pointed element so the user can follow the cursor. */
const pointDwellMs = (): number => {
  const v = Number(process.env.CUE_LIVE_POINT_DWELL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1100;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The next question to ask on summon. Voice (push-to-talk) and the in-app "ask"
 * box set this; it falls back to {@link DEFAULT_LOOK_QUESTION} and is consumed
 * (reset to null) on each summon.
 */
let pendingQuestion: string | null = null;
export const setPendingQuestion = (q: string | null): void => {
  pendingQuestion = q && q.trim() ? q.trim() : null;
};

/** Surface the last spoken answer to the renderer / TTS stage. */
let lastAnswer = "";
export const getLastAnswer = (): string => lastAnswer;

/** One-line summary of an action for the spoken/log history. */
const describeAction = (a: z.infer<typeof ACT_SCHEMA>["action"]): string => {
  if (!a) return "done";
  switch (a.type) {
    case "click":
    case "doubleclick":
    case "move":
      return `${a.type} (${Math.round(a.x ?? 0)},${Math.round(a.y ?? 0)})`;
    case "type":
      return `type "${(a.text ?? "").slice(0, 40)}"`;
    case "key":
      return `press ${a.key}`;
    case "scroll":
      return `scroll (${a.dx ?? 0},${a.dy ?? 0})`;
    default:
      return a.type;
  }
};

/**
 * Full-auto take-control loop: screenshot → ask the model for the next action →
 * perform it → repeat, until the model says done, the step cap is hit, a newer
 * summon supersedes this one, or the user presses Escape. Each `say` is shown +
 * spoken. Coordinates come back in screenshot pixels and are scaled to screen
 * points before being performed.
 */
const runActLoop = async (
  client: MacHelperClient,
  gen: number,
  goal: string,
  cursor: { x: number; y: number },
): Promise<void> => {
  abortRequested = false;
  log.info(`[cue-live] auto run: "${goal.slice(0, 80)}"`);
  let history = "";
  for (let step = 1; step <= MAX_ACT_STEPS; step++) {
    if (gen !== summonGeneration || abortRequested) {
      log.info(`[cue-live] auto run aborted before step ${step}`);
      return;
    }

    let cap: z.infer<typeof CAPTURE_SCHEMA>;
    try {
      const raw = await client.call(CUE_LIVE_CAPTURE_SCREEN, {
        maxWidth: 1280,
      });
      const parsed = CAPTURE_SCHEMA.safeParse(raw);
      if (!parsed.success) return;
      cap = parsed.data;
    } catch (err) {
      log.warn(`[cue-live] auto capture failed: ${errMessage(err)}`);
      return;
    }
    if (!cap.ok || !cap.data) {
      if (cap.reason === "screen-recording-permission") {
        await client
          .call(CUE_LIVE_SHOW_CARD, {
            title: "Cue Live needs Screen Recording",
            subtitle:
              "Enable Cue under System Settings → Privacy & Security → " +
              "Screen Recording, then try again.",
            x: cursor.x,
            y: cursor.y,
          })
          .catch(() => {});
        scheduleHide(client);
      }
      return;
    }

    if (step === 1) {
      await client
        .call(CUE_LIVE_SHOW_CARD, {
          title: "Cue",
          subtitle: "Working on it…  (press Esc to stop)",
          x: cursor.x,
          y: cursor.y,
        })
        .catch(() => {});
    }
    if (!guidanceFetcher) return;

    let act: z.infer<typeof ACT_SCHEMA>;
    try {
      const raw = await guidanceFetcher(CUE_LIVE_ACT_PATH, {
        goal,
        imageBase64: cap.data,
        mediaType: cap.mediaType ?? "image/png",
        imageWidth: cap.width ?? 0,
        imageHeight: cap.height ?? 0,
        step,
        history,
      });
      const parsed = ACT_SCHEMA.safeParse(raw);
      if (!parsed.success) {
        log.warn("[cue-live] act returned invalid payload");
        return;
      }
      act = parsed.data;
    } catch (err) {
      log.warn(`[cue-live] act failed: ${errMessage(err)}`);
      return;
    }
    if (gen !== summonGeneration || abortRequested) return;

    if (act.say) {
      lastAnswer = act.say;
      await client
        .call(CUE_LIVE_SHOW_CARD, {
          title: "Cue",
          subtitle: act.say,
          x: cursor.x,
          y: cursor.y,
        })
        .catch(() => {});
      void client.call(CUE_LIVE_SPEAK, { text: act.say }).catch(() => {});
    }

    if (act.done || !act.action || act.action.type === "none") {
      log.info(`[cue-live] auto run finished at step ${step}`);
      break;
    }

    const a = act.action;
    const scaleX = (cap.screenWidth ?? cap.width ?? 1) / (cap.width || 1);
    const scaleY = (cap.screenHeight ?? cap.height ?? 1) / (cap.height || 1);
    const payload: Record<string, unknown> = { type: a.type };
    if (a.x != null) payload.x = a.x * scaleX;
    if (a.y != null) payload.y = a.y * scaleY;
    if (a.text != null) payload.text = a.text;
    if (a.key != null) payload.key = a.key;
    if (a.dx != null) payload.dx = a.dx;
    if (a.dy != null) payload.dy = a.dy;
    await client
      .call(CUE_LIVE_PERFORM_ACTION, payload)
      .catch((err: unknown) =>
        log.warn(`[cue-live] performAction failed: ${errMessage(err)}`),
      );
    log.info(`[cue-live] auto step ${step}: ${describeAction(a)}`);
    history += `Step ${step}: ${describeAction(a)}\n`;
    await delay(ACT_STEP_DELAY_MS);
  }
  scheduleHide(client);
};

/**
 * On summon: a spoken goal with take-control on runs the full-auto act loop;
 * otherwise screenshot the screen, answer the (default or spoken) question, fly
 * the cursor to each thing it points at, and speak the answer. Best-effort
 * throughout — a permission gap or transient error degrades to a card, never a
 * crash.
 */
const handleSummon = async (
  client: MacHelperClient,
  cursor: { x: number; y: number; question?: string },
): Promise<void> => {
  // The spoken question (push-to-talk) wins; then an in-app ask; then default.
  const spokenGoal = cursor.question?.trim();

  // A spoken goal + take-control enabled → actually do the task.
  if (spokenGoal && takeControlEnabledGetter()) {
    clearHideTimer();
    const gen = ++summonGeneration;
    await runActLoop(client, gen, spokenGoal, cursor);
    return;
  }

  const question = spokenGoal ?? pendingQuestion ?? DEFAULT_LOOK_QUESTION;
  pendingQuestion = null;
  await lookAndPoint(client, question, cursor);
};

/**
 * ⌥P "point at element" — a pointing-only variant of the look flow. Captures
 * the screen, asks the model where to look, and flies the cursor to the
 * element(s) with a spoken/labeled answer. Distinct from summon (which may take
 * control on a spoken goal) and from ⌥R (which acts): this NEVER takes control.
 */
const handlePoint = async (
  client: MacHelperClient,
  cursor: { x: number; y: number },
): Promise<void> => {
  await lookAndPoint(client, POINT_QUESTION, cursor);
};

/**
 * Shared capture → `/cuelive/look` → point-at-each-element flow, used by both
 * summon (no spoken goal) and ⌥P point-at-element. Bumps the summon generation
 * so a slow response from a superseded call can't redraw the overlay.
 */
const lookAndPoint = async (
  client: MacHelperClient,
  question: string,
  cursor: { x: number; y: number },
): Promise<void> => {
  clearHideTimer();
  const gen = ++summonGeneration;

  // 1. Capture the screen.
  let cap: z.infer<typeof CAPTURE_SCHEMA>;
  try {
    const raw = await client.call(CUE_LIVE_CAPTURE_SCREEN, { maxWidth: 1280 });
    const parsed = CAPTURE_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      log.warn("[cue-live] captureScreen returned invalid payload");
      return;
    }
    cap = parsed.data;
  } catch (err) {
    log.warn(`[cue-live] captureScreen failed: ${errMessage(err)}`);
    return;
  }

  if (!cap.ok || !cap.data) {
    if (cap.reason === "screen-recording-permission") {
      await client
        .call(CUE_LIVE_SHOW_CARD, {
          title: "Cue Live needs Screen Recording",
          subtitle:
            "Enable Cue under System Settings → Privacy & Security → Screen " +
            "Recording, then summon again.",
          x: cursor.x,
          y: cursor.y,
        })
        .catch(() => {});
      scheduleHide(client);
      log.warn("[cue-live] capture blocked: Screen Recording not granted");
    } else {
      log.warn(`[cue-live] capture failed: ${cap.reason ?? "unknown"}`);
    }
    return;
  }

  // Immediate "thinking" card so the summon feels responsive.
  await client
    .call(CUE_LIVE_SHOW_CARD, {
      title: "Cue",
      subtitle: "Looking at your screen…",
      x: cursor.x,
      y: cursor.y,
    })
    .catch(() => {});
  scheduleHide(client);

  if (!guidanceFetcher) {
    log.info("[cue-live] no daemon fetcher wired; cannot ask the model");
    return;
  }

  // 2. Ask the model (vision): screenshot + question → answer + points.
  let look: z.infer<typeof LOOK_SCHEMA>;
  try {
    const raw = await guidanceFetcher(CUE_LIVE_LOOK_PATH, {
      question,
      imageBase64: cap.data,
      mediaType: cap.mediaType ?? "image/png",
      imageWidth: cap.width ?? 0,
      imageHeight: cap.height ?? 0,
    });
    const parsed = LOOK_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      log.warn("[cue-live] look returned invalid payload");
      return;
    }
    look = parsed.data;
  } catch (err) {
    log.warn(`[cue-live] look failed: ${errMessage(err)}`);
    return;
  }
  if (gen !== summonGeneration) return; // a newer summon superseded this one

  // A failed look carries `error` and no answer. Speaking it beats the silent
  // return this used to do: the owner summoned Cue and deserves to hear why
  // nothing happened, not watch it stare blankly at the screen.
  if (look.error && !look.answer) {
    log.warn(`[cue-live] look failed: ${look.error}`);
    void client
      .call(CUE_LIVE_SPEAK, { text: look.error })
      .catch((err: unknown) =>
        log.warn(`[cue-live] speak failed: ${errMessage(err)}`),
      );
    return;
  }

  lastAnswer = look.answer;
  log.info(
    `[cue-live] look → "${look.answer.slice(0, 80)}" ` +
      `(${look.points.length} point(s))`,
  );

  // Speak the answer (ElevenLabs, in the helper) while the cursor points —
  // concurrent, like clicky. No-op when no TTS key is configured.
  if (look.answer) {
    void client
      .call(CUE_LIVE_SPEAK, { text: look.answer })
      .catch((err: unknown) =>
        log.warn(`[cue-live] speak failed: ${errMessage(err)}`),
      );
  }

  // 3. Map points from screenshot-pixels → screen-points and fly the cursor.
  const scaleX = (cap.screenWidth ?? cap.width ?? 1) / (cap.width || 1);
  const scaleY = (cap.screenHeight ?? cap.height ?? 1) / (cap.height || 1);
  for (const p of look.points.slice(0, MAX_POINTS)) {
    if (gen !== summonGeneration) return;
    await client
      .call(CUE_LIVE_POINT_AT, {
        x: p.x * scaleX,
        y: p.y * scaleY,
        label: p.label,
      })
      .catch((err: unknown) =>
        log.warn(`[cue-live] pointAt failed: ${errMessage(err)}`),
      );
    await delay(pointDwellMs());
  }

  // 4. Show the spoken answer (TTS speaks it in a later stage).
  if (gen === summonGeneration && look.answer) {
    await client
      .call(CUE_LIVE_SHOW_CARD, {
        title: "Cue",
        subtitle: look.answer,
        x: cursor.x,
        y: cursor.y,
      })
      .catch(() => {});
    scheduleHide(client);
  }
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
 * Run a typed goal — the in-app test box. `takeControl: true` drives it like a
 * spoken goal (so the act loop engages when take-control is enabled);
 * `false` runs a look-only "explain" pass with the goal as the question. Lets
 * the click loop be tested with just the Anthropic key — no mic / voice keys.
 */
export const runTypedGoal = async (
  goal: string,
  takeControl: boolean,
): Promise<void> => {
  if (!started) return;
  const trimmed = goal.trim();
  if (!trimmed) return;
  try {
    if (takeControl) {
      await getMacHelperClient().call(CUE_LIVE_SUMMON_GOAL, {
        question: trimmed,
      });
    } else {
      pendingQuestion = trimmed;
      await getMacHelperClient().call(CUE_LIVE_SUMMON_NOW);
    }
  } catch (err) {
    log.warn(`[cue-live] runTypedGoal failed: ${errMessage(err)}`);
  }
};

/**
 * Stop everything immediately: abort any in-progress full-auto run, supersede
 * any pending summon, and hide the overlay card/ring. Backs the in-app "Stop"
 * control (the same outcome as pressing Escape, reachable without focus on the
 * overlay). Safe to call when nothing is running.
 */
export const stopEverything = async (): Promise<void> => {
  abortRequested = true;
  // Bump the generation so a slow guidance/act response can't redraw a card.
  summonGeneration++;
  if (!started) return;
  clearHideTimer();
  try {
    await getMacHelperClient().call(CUE_LIVE_HIDE);
  } catch (err) {
    log.warn(`[cue-live] stopEverything hide failed: ${errMessage(err)}`);
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
      // A second summon ~2s later: over a Chromium/Electron app the first
      // summon only primes the AX tree (AXManualAccessibility), so the second
      // is what actually reads. Exercises the prime-then-read path.
      setTimeout(() => {
        log.info("[cue-live] self-test: second summon (post-prime read)");
        void triggerSummon();
      }, 2_000);
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

  // ⌥R (backlog #29): the push-to-talk run hotkey. The native helper already
  // parses + emits this; here it becomes a "start Cue Live voice" signal to the
  // renderer. We only need the fact of the press (defensive checks live in
  // handleRun), so the cursor payload is parsed but unused.
  unsubscribeRun = client.onNotification(CUE_LIVE_RUN, RUN_SCHEMA, () => {
    handleRun();
  });

  // ⌥P (point at element): the helper reports the cursor; Electron-main runs the
  // pointing-only look flow (no take-control). Reuses SUMMONED_SCHEMA — point
  // emits x/y and never a question.
  unsubscribePoint = client.onNotification(
    CUE_LIVE_POINT,
    SUMMONED_SCHEMA,
    (cursor) => {
      void handlePoint(client, cursor);
    },
  );

  // The helper arms the summon hotkey the moment Accessibility is granted at
  // runtime (no relaunch needed); surface that transition for diagnosability.
  unsubscribeTrusted = client.onNotification(
    CUE_LIVE_ACCESSIBILITY_TRUSTED,
    TRUSTED_SCHEMA,
    () => {
      lastKnownTrusted = true;
      log.info(
        "[cue-live] Accessibility granted — summon hotkey is now armed " +
          "(Control+Option+Space).",
      );
    },
  );

  // Escape (from the helper) aborts an in-progress full-auto run.
  unsubscribeAbort = client.onNotification(CUE_LIVE_ABORT, z.unknown(), () => {
    abortRequested = true;
  });

  try {
    const raw = await client.call(CUE_LIVE_START);
    const parsed = START_RESULT_SCHEMA.safeParse(raw);
    if (!parsed.success || !parsed.data.enabled) {
      log.warn("[cue-live] cuelive.start did not enable the overlay");
      // Leave the subscription in place; the helper may enable on retry.
      return;
    }
    lastKnownTrusted = parsed.data.accessibilityTrusted === true;
    // Prime the Screen-Recording cache the moment the helper is reachable.
    // `status` serves it from `lastKnownScreenRecording`, which starts false,
    // so until something calls `getPermissions()` a granted machine reports
    // "not granted". It errs safe, but only by accident — read it for real.
    void getPermissions();
    // Hand the helper the voice keys (push-to-talk STT + TTS) now that it's up.
    void pushVoiceConfig();
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
  abortRequested = true;
  unsubscribeSummoned?.();
  unsubscribeSummoned = null;
  unsubscribeRun?.();
  unsubscribeRun = null;
  unsubscribePoint?.();
  unsubscribePoint = null;
  unsubscribeTrusted?.();
  unsubscribeTrusted = null;
  unsubscribeAbort?.();
  unsubscribeAbort = null;

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
  abortRequested = true;
  clearHideTimer();
  unsubscribeSummoned?.();
  unsubscribeSummoned = null;
  unsubscribeRun?.();
  unsubscribeRun = null;
  unsubscribePoint?.();
  unsubscribePoint = null;
  unsubscribeTrusted?.();
  unsubscribeTrusted = null;
  unsubscribeAbort?.();
  unsubscribeAbort = null;
};

export const __resetForTesting = (): void => {
  started = false;
  abortRequested = false;
  clearHideTimer();
  unsubscribeSummoned?.();
  unsubscribeSummoned = null;
  unsubscribeRun?.();
  unsubscribeRun = null;
  unsubscribePoint?.();
  unsubscribePoint = null;
  unsubscribeTrusted?.();
  unsubscribeTrusted = null;
  unsubscribeAbort?.();
  unsubscribeAbort = null;
  persistedEnabledGetter = () => true;
  takeControlEnabledGetter = () => true;
  startVoiceDispatcher = null;
  lastKnownTrusted = false;
  lastKnownScreenRecording = false;
};
