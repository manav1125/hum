import { Menu, powerMonitor, screen, type BrowserWindow } from "electron";
import { z } from "zod";

import {
  CompanionDrag,
  type DragPoint,
} from "./companion-drag";
import {
  COMPANION_SIZES,
  DEFAULT_COMPANION_SIZE,
  geometryFor,
  type CompanionSize,
} from "./companion-geometry";
import { CompanionHitTest } from "./companion-hit-test";
import { CompanionDrops, describeDrop, type DropChoice } from "./companion-drop";
import { CompanionIntro } from "./companion-intro";
import {
  CompanionNudges,
  type HeldNudge,
  type NudgeVerdict,
} from "./companion-nudge";
import {
  buildCompanionMenu,
  type CompanionBlink,
  type CompanionMenuAction,
  type CompanionMenuItem,
  type CompanionWeight,
} from "./companion-menu";
import {
  CompanionPhaseStore,
  type CompanionSignals,
} from "./companion-phase";
import { CompanionPlacement, type PlacementHost } from "./companion-placement";
import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle, on } from "./ipc";
import {
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
} from "./main-window";
import {
  clearSetting,
  onSettingChange,
  readSetting,
  writeSetting,
} from "./settings";
import { isSignedIn, onSignedInChange } from "./session-state";
import { getStatus, onStatusChange } from "./status";
import { isCompanionEnabled } from "./desktop-surface-flags";

/**
 * The always-on companion — design `C1`–`C3`, and the window that hosts them.
 *
 * This file owns the parts only main can own, and deliberately nothing else:
 *
 *   · **The canvas, which never resizes on a phase.** One window, sized for
 *     the widest state the surface can reach, with the creature anchored to
 *     the near edge of it. The old companion grew its window from 72×72 to
 *     260×148 to show a card — a window that resizes on every phase change is
 *     a window resizing constantly, and it is also why real glass is
 *     unavailable (a vibrancy material fills its window). See
 *     `companion-geometry.ts`. The single legitimate resize is a *size* step
 *     the user asked for.
 *   · **Which way it has room to unfurl.** Growth and card-growth are facts
 *     about the work area the creature is parked in, and the renderer has no
 *     access to that. See `companion-placement.ts`.
 *   · **Who owns the clicks.** The canvas is many times the size of anything
 *     drawn in it, so it is transparent to clicks until the renderer says the
 *     pointer is genuinely over something. See `companion-hit-test.ts` — three
 *     of upstream's five bugs ended with this window eating clicks meant for
 *     other applications.
 *   · **The drag.** Moves come from main polling the cursor, never from
 *     renderer events, so a fast drag cannot outrun a window moved one IPC
 *     message at a time. See `companion-drag.ts`.
 *
 * Gating is unchanged: the `desktop-companion` flag (with the
 * `VELLUM_FLAG_DESKTOP_COMPANION` env override) decides whether any of this
 * exists at all, and `companionVisible` is the user's own show/hide choice.
 */

const COMPANION_KIND = "companion";
const COMPANION_PATH = "/floating/companion";

/** How often main reads the cursor while a drag is held. ~60Hz. */
const DRAG_POLL_MS = 16;

/**
 * Where the creature stands on first run: the right edge, below the middle.
 *
 * Low enough to be out of the way of what people actually work in, and on an
 * edge from the very first frame — `C8`'s rule is that the creature lives on
 * an edge, so it should never have to be dragged to one to look right.
 */
const FIRST_RUN_HEIGHT_FRACTION = 0.62;

/**
 * The persisted show/hide choice. Defaults to visible so enabling the flag
 * is sufficient to see the companion; hiding from the tray (or the window's
 * own hide action) persists until the user shows it again.
 */
export const isCompanionVisible = (): boolean => {
  if ((readSetting("companionVisible") ?? true) === false) return false;
  const until = readSetting("companionHiddenUntil");
  // Stored as an instant rather than a flag, so it cannot get stuck: a flag
  // needs something to clear it, and that something is exactly what does not
  // run when the app was closed all evening.
  return !until || Date.now() >= Date.parse(until);
};

/** The creature's character (`C5`), with the quiet defaults. */
export const companionCharacter = (): {
  blink: CompanionBlink;
  weight: CompanionWeight;
} => {
  const stored = readSetting("companionCharacter") ?? {};
  return {
    blink: stored.blink ?? "calm",
    weight: stored.weight ?? "regular",
  };
};

/** Quiet hours, or `null` when they are off. */
export const companionQuietHours = (): { start: string; end: string } | null =>
  readSetting("companionQuietHours") ?? null;

/**
 * Whether the clock is currently inside quiet hours.
 *
 * Written to survive a window that crosses midnight, which the default range
 * (22:00–07:30) does — the naive comparison is false for every minute of it.
 */
export const inQuietHours = (
  hours: { start: string; end: string } | null,
  now: Date,
): boolean => {
  if (!hours) return false;
  const minutes = (hhmm: string): number => {
    const [h = "0", m = "0"] = hhmm.split(":");
    return Number(h) * 60 + Number(m);
  };
  const start = minutes(hours.start);
  const end = minutes(hours.end);
  const at = now.getHours() * 60 + now.getMinutes();
  return start <= end ? at >= start && at < end : at >= start || at < end;
};

/**
 * The creature's size — a named step, never overridden once chosen (`C12`).
 */
export const companionSize = (): CompanionSize => {
  const stored = readSetting("companionSize");
  return (COMPANION_SIZES as readonly string[]).includes(stored ?? "")
    ? (stored as CompanionSize)
    : DEFAULT_COMPANION_SIZE;
};

const companionWindow = (): BrowserWindow | null =>
  getFloatingWindow(COMPANION_KIND);

/**
 * The signals the app publishes. Strict: an unknown key here would be a
 * signal nobody resolves, which is worse than a validation failure because it
 * looks like it worked.
 */
const signalsSchema = z
  .object({
    online: z.boolean(),
    watching: z.boolean(),
    recording: z
      .object({ label: z.string(), elapsed: z.string() })
      .nullable(),
    awaitingApproval: z.boolean(),
    couldnt: z.boolean(),
    typing: z.boolean(),
    listening: z.boolean(),
    quiet: z.boolean(),
  })
  .partial()
  .strict();

let placement: CompanionPlacement | null = null;
let phases: CompanionPhaseStore | null = null;
let intro: CompanionIntro | null = null;
let nudges: CompanionNudges | null = null;
let drops: CompanionDrops | null = null;
let caught: import("@vellumai/ipc-contract").CompanionCaught | null = null;
let opening = false;
let heldNudge: HeldNudge | null = null;
let hitTest: CompanionHitTest | null = null;
let drag: CompanionDrag | null = null;
let dragPoll: ReturnType<typeof setInterval> | null = null;

const send = (channel: string, payload: unknown): void => {
  const win = companionWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
};

/**
 * Everything the renderer needs to draw, as one message.
 *
 * `hover` is here rather than decided in the page for the reason the whole
 * forwarding trick exists: a renderer that decided its own hover would have to
 * claim the entire canvas to find out it was being pointed at.
 */
const companionState = (): Record<string, unknown> => {
  const current = placement?.current();
  const geometry = current?.geometry ?? geometryFor(companionSize());
  const resolved = phases?.current() ?? { phase: "resting" as const };
  const character = companionCharacter();
  // The introduction never covers something that is happening. It is the one
  // card Cue shows without being asked, so it yields to everything the user
  // is actually in the middle of and comes back when they are not.
  const introducing =
    resolved.phase === "resting" || resolved.phase === "hover"
      ? intro?.current()
      : null;
  return {
    ...resolved,
    ...(introducing ? { intro: introducing } : {}),
    // The glint an ignored nudge retracts to. Never lost, never repeated out
    // loud — it waits for a hover rather than saying itself again.
    ...(heldNudge ? { heldNudge: heldNudge.line } : {}),
    // The arc opening is a thing the creature does, not a phase — it has to
    // work in the middle of whatever else is true, including a recording,
    // whose evidence nothing may cover (`C10`, `C11`).
    ...(opening ? { opening: true } : {}),
    ...(caught ? { caught } : {}),
    avatarBox: geometry.avatarBox,
    growth: current?.growth ?? "right",
    cardGrowth: current?.cardGrowth ?? "up",
    blink: character.blink,
    weight: character.weight,
    quiet: inQuietHours(companionQuietHours(), new Date()),
  };
};

const publishState = (): void => {
  send("vellum:companion:state", companionState());
};

/** First-run home, or the centre the user last settled the creature at. */
const startingCentre = (size: CompanionSize): DragPoint => {
  const stored = readSetting("companionCentre");
  if (stored && typeof stored.x === "number" && typeof stored.y === "number") {
    return { x: stored.x, y: stored.y };
  }
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return {
    x: x + width - geometryFor(size).nearEdge,
    y: Math.round(y + height * FIRST_RUN_HEIGHT_FRACTION),
  };
};

const placementHost: PlacementHost = {
  bounds: () => companionWindow()?.getBounds() ?? null,
  workAreaNear: (point) => screen.getDisplayNearestPoint(point).workArea,
  setPosition: (x, y) => {
    companionWindow()?.setPosition(x, y);
  },
  setSize: (width, height) => {
    const win = companionWindow();
    if (!win) return;
    // A fixed-size panel has to be unlocked for a programmatic resize; this is
    // the documented dance, and the only resize the companion ever performs.
    win.setResizable(true);
    win.setBounds({ ...win.getBounds(), width, height });
    win.setResizable(false);
  },
  publish: () => publishState(),
};

/**
 * Who says the pointer is over something.
 *
 * **Two sources, deliberately.** The renderer reports coverage from the drawn
 * rectangle, which is the only side that knows how wide the pill currently
 * is. But it learns where the pointer is from forwarded mouse-move, and a
 * *native drag* — a file coming from Finder — does not forward one: the
 * window is click-through, so the operating system does not offer it the drag
 * at all, and it can never become a drop target.
 *
 * Main can answer for the creature's own box without any of that, because it
 * knows the box and the cursor in the same screen coordinates. So it polls
 * slowly for exactly that case, and the two answers are OR-ed: either side
 * saying yes claims the canvas, which cannot flap the way two competing
 * authorities would.
 */
let pointerOverDrawn = false;
let cursorOnCreature = false;

const applyHitTest = (): void => {
  hitTest?.set(pointerOverDrawn || cursorOnCreature);
};

/**
 * How often main checks whether the cursor is over the creature.
 *
 * Slow on purpose. This exists to catch a drag approaching, not to track a
 * pointer — the renderer already does that far better, for free, whenever the
 * window is not click-through to a drag.
 */
const PROXIMITY_POLL_MS = 120;

let proximityPoll: ReturnType<typeof setInterval> | null = null;

const startProximityPoll = (): void => {
  stopProximityPoll();
  proximityPoll = setInterval(() => {
    const centre = placement?.centre();
    const box = placement?.current().geometry.avatarBox;
    if (!centre || !box) return;
    const at = screen.getCursorScreenPoint();
    const half = box / 2;
    const over =
      Math.abs(at.x - centre.x) <= half && Math.abs(at.y - centre.y) <= half;
    if (over === cursorOnCreature) return;
    cursorOnCreature = over;
    applyHitTest();
  }, PROXIMITY_POLL_MS);
};

const stopProximityPoll = (): void => {
  if (!proximityPoll) return;
  clearInterval(proximityPoll);
  proximityPoll = null;
};

/**
 * Stop following the cursor.
 *
 * Called from every path that can end a drag, including the ones that are not
 * a mouse-up at all — the window going away mid-gesture has to end the press
 * too, or the poll outlives the window it was moving.
 */
const stopDragPoll = (): void => {
  if (!dragPoll) return;
  clearInterval(dragPoll);
  dragPoll = null;
};

/**
 * End a drag from somewhere that is not the button coming up: the window lost
 * focus, or went away. The press must never outlive the gesture.
 */
const abandonDrag = (): void => {
  stopDragPoll();
  if (drag?.isHeld()) drag.end();
};

const openCompanionWindow = (): BrowserWindow => {
  const existing = companionWindow();
  if (existing) return existing;

  const size = companionSize();
  const geometry = geometryFor(size);

  const win = createFloatingWindow({
    kind: COMPANION_KIND,
    route: COMPANION_PATH,
    width: geometry.canvasWidth,
    height: geometry.canvasHeight,
    // Non-activating: the creature must never steal focus from the app the
    // user is working in. Its actions surface the main window explicitly.
    focusOnShow: false,
    alwaysOnTopLevel: "floating",
    visibleOnAllWorkspaces: true,
    browserWindow: {
      movable: true,
      minimizable: false,
      maximizable: false,
      // The page paints on a fully transparent canvas; a native shadow would
      // draw a rectangle around a window that is mostly empty.
      hasShadow: false,
      backgroundColor: "#00000000",
    },
  });

  placement = new CompanionPlacement(placementHost, size);
  phases = new CompanionPhaseStore(() => publishState());
  drops = new CompanionDrops({
    present: (item) => {
      caught = item;
      phases?.set({ caught: item !== null });
      // A caught chip appearing or vanishing changes the drawn area under a
      // pointer that has no reason to move — the same leak the introduction
      // has, for the same reason.
      afterCardRemoved();
    },
    hand: (choice, item, payload) => {
      void ensureMainWindowVisible().then(() =>
        dispatchToMain({
          kind: "handleDrop",
          choice,
          dropKind: item.kind,
          label: item.label,
          payload,
        }),
      );
    },
  });
  nudges = new CompanionNudges({
    present: (nudge) => {
      phases?.set({
        nudge: nudge ? { line: nudge.line, itemId: nudge.itemId } : null,
      });
    },
    hold: (nudge) => {
      heldNudge = nudge;
      publishState();
    },
    taught: (nudge) =>
      dispatchToMain({
        kind: "nudgeDismissed",
        itemId: nudge.itemId,
        ...(nudge.subject ? { subject: nudge.subject } : {}),
      }),
    now: () => Date.now(),
  });
  intro = new CompanionIntro(readSetting("companionIntroSeen") ?? false, () => {
    writeSetting("companionIntroSeen", true);
  });
  phases.set({
    busy: getStatus() === "thinking",
    approvalExplained: readSetting("companionApprovalExplained") ?? false,
  });
  hitTest = new CompanionHitTest({ window: companionWindow });
  drag = new CompanionDrag({
    moveTo: (centre) => placement?.moveTo(centre),
    settle: (centre) => {
      const landed = placement?.settle(centre);
      // The creature stays where it was left, across restarts. Persisting the
      // *centre* rather than the window's bounds is what keeps this stable
      // when the growth direction — and so the origin's meaning — changes.
      if (landed) writeSetting("companionCentre", landed);
    },
    setInteractive: (interactive) => {
      // A drag holds the canvas outright while it runs, then hands the
      // decision back to the two ordinary sources rather than to `false` —
      // the pointer is very often still on the creature it was just dragging.
      if (interactive) hitTest?.set(true);
      else applyHitTest();
    },
  });

  // Transparent to clicks from the very first frame, while still receiving
  // mouse-move. A new window that claimed its canvas would swallow presses
  // before anything had even been drawn.
  hitTest.install();
  placement.moveTo(startingCentre(size));
  // Main answers for the creature's own box so a native drag can reach it.
  startProximityPoll();

  // The route chunk loads lazily; publish once the renderer is ready so the
  // creature doesn't wait for the next thing to change.
  win.webContents.on("did-finish-load", () => {
    publishState();
  });

  win.on("blur", abandonDrag);
  win.on("closed", () => {
    abandonDrag();
    nudges?.stop();
    nudges = null;
    drops?.stop();
    drops = null;
    caught = null;
    opening = false;
    stopProximityPoll();
    pointerOverDrawn = false;
    cursorOnCreature = false;
    heldNudge = null;
    placement = null;
    phases = null;
    intro = null;
    hitTest = null;
    drag = null;
  });

  return win;
};

/**
 * The pointer is, or is not, over something actually drawn.
 *
 * The other half of the forwarding trick: the canvas goes back to transparent
 * the moment this says no, which is what keeps the empty region — most of the
 * window — out of the way of clicks meant for the application behind.
 *
 * Ignored while a drag is held, because during a drag the answer is already
 * yes and the renderer's own idea of where the pointer is is the thing a drag
 * outruns.
 */
export const setCompanionPointerOver = (over: boolean): void => {
  if (drag?.isHeld()) return;
  pointerOverDrawn = over;
  applyHitTest();
  // A held glint replays its line when you finally look at it — once, and
  // silently. This is the only thing that brings an ignored nudge back.
  if (over) nudges?.hover();
  // Hover is a phase, and the store decides whether it is the phase that
  // wins — a pointer near a creature that is already recording changes
  // nothing anyone can see, and republishing it would redraw on nothing.
  phases?.set({ hover: over });
};

/**
 * A press landed on the creature.
 *
 * Main reads the cursor itself from here on: the renderer's coordinates are
 * exactly what a fast drag outruns, and polling the cursor means the creature
 * tracks the hand rather than a trail of IPC messages.
 */
export const beginCompanionDrag = (): void => {
  const centre = placement?.centre();
  if (!drag || !centre) return;
  drag.begin(screen.getCursorScreenPoint(), centre);
  stopDragPoll();
  dragPoll = setInterval(() => {
    if (!drag?.isHeld()) {
      stopDragPoll();
      return;
    }
    drag.move(screen.getCursorScreenPoint());
  }, DRAG_POLL_MS);
};

/**
 * The button came up — wherever it came up.
 *
 * The renderer captures the pointer for the duration of the press, so the
 * `pointerup` is delivered to it even when the pointer is over another
 * application by then. Losing the window ends the press too (`blur`,
 * `closed`), so there is no path where a press outlives its gesture and
 * leaves the window claiming the canvas.
 */
export const endCompanionDrag = (): void => {
  stopDragPoll();
  if (!drag?.isHeld()) return;
  drag.end(screen.getCursorScreenPoint());
};

/**
 * What the app knows and the companion cannot see for itself.
 *
 * One channel rather than one per signal: they arrive together, they are all
 * fire-and-forget, and the phase is resolved from the whole set anyway — so a
 * patch that changed two of them across two channels would resolve twice and
 * publish a phase that was true for neither moment.
 */
export const applyCompanionSignals = async (
  patch: Partial<CompanionSignals>,
): Promise<void> => {
  const before = phases?.read();
  phases?.set(patch);

  const raised =
    patch.awaitingApproval === true && before?.awaitingApproval !== true;
  if (raised) {
    // **Upstream's rule, adopted (`C6`).** Approvals raise the app window; the
    // companion badges until it is answered and never renders the approval
    // itself. It is also the live candidate for our dropped-approval bug: an
    // approval nobody can reach is the failure, and a window in front of you
    // is the bluntest possible fix.
    await ensureMainWindowVisible();
    // `C9`'s long sentence is showing right now, so the flag is persisted but
    // deliberately not fed back into the store yet — swapping the line out
    // from under someone mid-read would be the one thing worse than repeating
    // it.
    writeSetting("companionApprovalExplained", true);
  }

  if (patch.awaitingApproval === false && before?.awaitingApproval === true) {
    phases?.set({
      approvalExplained: readSetting("companionApprovalExplained") ?? false,
    });
  }
};

/**
 * Whether a capture is running right now (`C11`).
 *
 * Recording and watching are the only two states that are *evidence* — the
 * creature is the always-visible proof that audio is being kept or a window is
 * being read. Everything else about the companion is presentation.
 */
export const captureLive = (): "recording" | "watching" | null => {
  const signals = phases?.read();
  if (signals?.recording) return "recording";
  if (signals?.watching) return "watching";
  return null;
};

/**
 * Stop the capture — the real one.
 *
 * The mirror's `Stop` stops the session it is mirroring, not the mirror. A
 * Stop that only stopped the picture of a recording would be the worst button
 * in the product: it looks like it worked, and the microphone is still on.
 */
export const stopCompanionCapture = async (): Promise<void> => {
  const capture = captureLive();
  if (!capture) return;
  dispatchToMain({ kind: "stopCapture", capture });
  // The app owns the session and will publish the signal back when it has
  // actually stopped. Clearing it here would be the creature claiming
  // something it does not know.
  await Promise.resolve();
};

/**
 * Offer a nudge, and answer whether it was taken.
 *
 * The answer is the whole point: the interruption budget is shared with push,
 * and a nudge **replaces** the notification rather than doubling it — which
 * only works if one side decides and the other believes it. A refusal leaves
 * the budget untouched, so the caller can push instead.
 */
export const offerCompanionNudge = (request: {
  itemId: string;
  line: string;
  source: string;
}): NudgeVerdict => {
  if (!nudges) return { allowed: false, reason: "hidden" };
  return nudges.offer(request, {
    // Not keystrokes specifically: what is available without a system-wide
    // keyboard hook is any input at all, and interrupting somebody mid-drag
    // is no better than interrupting them mid-sentence.
    sinceInputMs: powerMonitor.getSystemIdleTime() * 1_000,
    quiet: inQuietHours(companionQuietHours(), new Date()),
    visible: isCompanionEnabled() && isCompanionVisible(),
  });
};

/** Nudges the menu bar is holding because nothing could show them (`C11`). */
export const companionHeldCount = (): number => nudges?.heldCount() ?? 0;

/**
 * Show one of them, now that there is somewhere to show it.
 *
 * Brings the creature back first if it was hidden — being asked to replay is
 * as clear a request to see it as pressing "Show Cue".
 */
export const replayCompanionNudge = (): void => {
  if (!isCompanionVisible()) {
    clearSetting("companionHiddenUntil");
    writeSetting("companionVisible", true);
    syncCompanionWindow();
  }
  nudges?.replayWithheld({
    sinceInputMs: powerMonitor.getSystemIdleTime() * 1_000,
    quiet: inQuietHours(companionQuietHours(), new Date()),
    visible: true,
  });
};

/** The right-click menu's current state, read from what is persisted. */
const menuState = () => ({
  size: companionSize(),
  ...companionCharacter(),
  quietHours: companionQuietHours(),
  watching: phases?.read().watching ?? false,
});

/**
 * Act on a menu choice.
 *
 * Exported so the rules can be checked without popping a native menu — the
 * interesting ones are not "does it call the right function" but what a
 * choice is allowed to do at all: nothing here sends or spends, because the
 * companion talks and only the app acts (`C9`).
 */
export const runCompanionMenuAction = async (
  action: CompanionMenuAction,
): Promise<void> => {
  switch (action.kind) {
    case "newNote":
      // Capture only. The companion hands off to Notes and never becomes the
      // editor (`Q4`).
      await ensureMainWindowVisible();
      dispatchToMain({ kind: "newNote" });
      return;
    case "readWindow":
      phases?.set({ watching: true });
      return;
    case "stopReading":
      await stopCompanionCapture();
      return;
    case "openCue":
      await ensureMainWindowVisible();
      return;
    case "setSize":
      setCompanionSize(action.size);
      return;
    case "setBlink":
      writeSetting("companionCharacter", {
        ...(readSetting("companionCharacter") ?? {}),
        blink: action.blink,
      });
      publishState();
      return;
    case "setWeight":
      writeSetting("companionCharacter", {
        ...(readSetting("companionCharacter") ?? {}),
        weight: action.weight,
      });
      publishState();
      return;
    case "setQuietHours":
      if (action.enabled) {
        writeSetting("companionQuietHours", { start: "22:00", end: "07:30" });
      } else {
        clearSetting("companionQuietHours");
      }
      phases?.set({
        quiet: inQuietHours(companionQuietHours(), new Date()),
      });
      publishState();
      return;
    case "hideUntilTomorrow":
    case "hide":
      // **A live capture cannot be hidden** (`C11`). The creature is the only
      // always-visible evidence that audio is being kept or a window is being
      // read, so hiding it while either runs would remove the one thing that
      // says so — leaving a capture running with nothing on screen to admit
      // it. Stop it first; the menu offers exactly that, in this same menu.
      if (captureLive()) return;
      if (action.kind === "hideUntilTomorrow") {
        writeSetting("companionHiddenUntil", nextLocalMidnight().toISOString());
      } else {
        writeSetting("companionVisible", false);
      }
      syncCompanionWindow();
      return;
  }
};

/** When "tomorrow" starts, in the owner's own timezone. */
export const nextLocalMidnight = (from: Date = new Date()): Date => {
  const next = new Date(from);
  next.setHours(24, 0, 0, 0);
  return next;
};

/** Translate the template into Electron's shape, keeping the actions. */
const toElectronMenu = (
  items: CompanionMenuItem[],
): Electron.MenuItemConstructorOptions[] =>
  items.map((item) => ({
    ...(item.type === "separator"
      ? { type: "separator" as const }
      : {
          label: item.label,
          ...(item.sublabel ? { sublabel: item.sublabel } : {}),
          ...(item.type === "radio"
            ? { type: "radio" as const, checked: item.checked }
            : {}),
          ...(item.submenu ? { submenu: toElectronMenu(item.submenu) } : {}),
          ...(item.action
            ? { click: () => void runCompanionMenuAction(item.action!) }
            : {}),
        }),
  }));

/**
 * Pop the right-click menu.
 *
 * A native menu rather than a drawn one, because the menu is routinely taller
 * than the creature and a drawn one would have to grow the canvas to hold it —
 * the one thing the fixed canvas exists to prevent.
 */
export const popCompanionMenu = (): void => {
  const win = companionWindow();
  if (!win) return;
  Menu.buildFromTemplate(toElectronMenu(buildCompanionMenu(menuState()))).popup({
    window: win,
  });
};

/**
 * A card moved, shrank, or went away.
 *
 * **Whatever removed it has to hand the canvas back itself.** Advancing an
 * introduction beat shrinks the card, dismissing removes it, answering a
 * nudge retracts it — all under a pointer that has no reason to move
 * afterwards — and with no mouse-move to follow, nothing
 * recomputes the hit-test. The window would go on claiming a canvas many
 * times the size of the creature, swallowing clicks meant for whatever is
 * behind it, until the user happened to move the mouse. This is the leak
 * upstream shipped in exactly this card (`64e3eead`).
 *
 * Releasing first is always safe: the renderer reports coverage again on its
 * next frame if the pointer really is still over something.
 */
const afterCardRemoved = (): void => {
  // The renderer's last report is stale the moment a card is removed — it
  // described an area that no longer exists — so it is discarded rather than
  // re-applied, which would instantly undo the release and leave the leak
  // exactly where it was. What survives is main's own knowledge: if the
  // cursor is on the creature, the creature is still drawn and the canvas
  // stays claimed. The renderer reports again on its next frame.
  pointerOverDrawn = false;
  hitTest?.releaseAfterRemoval();
  applyHitTest();
  publishState();
};

/**
 * `⌥Space` — open the typing card where the creature already is (`C12`).
 *
 * A pointer-free path to the thing the companion is for. It does not move the
 * creature, raise anything or take focus: the card unfurls from where the
 * creature is parked, which is the whole reason the canvas is already big
 * enough to hold it.
 *
 * Pressing it again closes the card, because a summon that only opens is a
 * summon you have to reach for the mouse to undo.
 */
export const summonCompanionCard = (): void => {
  if (!isCompanionEnabled() || !isCompanionVisible()) return;
  // A hidden companion is summoned back into view rather than refused: the
  // key is the way in for somebody who cannot reach the menu bar either.
  if (!companionWindow()) syncCompanionWindow();
  const typing = phases?.read().typing ?? false;
  phases?.set({ typing: !typing });
  // Opening a card, and closing one, both change the drawn area under a
  // pointer that has no reason to move.
  afterCardRemoved();
};

/** A named size step (`C12`). The one thing that legitimately resizes. */
export const setCompanionSize = (size: CompanionSize): void => {
  writeSetting("companionSize", size);
  placement?.setSize(size);
  const centre = placement?.centre();
  if (centre) writeSetting("companionCentre", centre);
};

/**
 * Reconcile the window with the flag + visibility settings: open it when
 * the companion should be on screen, close it when it should not. Safe to
 * call repeatedly; the underlying window is a singleton.
 */
export const syncCompanionWindow = (): void => {
  // **Not before there is a session.** The companion is a window onto the same
  // SPA, so opening it signed-out renders the *sign-in screen* inside a canvas
  // sized for a creature — a second Welcome window nobody asked for, sitting
  // beside the real one. And because it loaded signed-out it stays that way:
  // nothing reloads it when the session finally arrives.
  //
  // Gating on the session fixes both. The creature appears once Cue is signed
  // in, which is also the first moment it has anything to be about.
  const shouldShow =
    isCompanionEnabled() && isCompanionVisible() && isSignedIn();
  const existing = companionWindow();
  if (shouldShow && !existing) {
    openCompanionWindow();
    return;
  }
  if (!shouldShow && existing) {
    existing.close();
  }
};

/**
 * Tray "Show/Hide Cue Companion": flip the persisted visibility choice and
 * reconcile. (The flag itself is not touched — a hidden companion with the
 * flag on stays one tray click away.)
 */
export const toggleCompanionWindow = (): void => {
  writeSetting("companionVisible", !isCompanionVisible());
  syncCompanionWindow();
};

/**
 * "Talk to Cue" (tray item and the companion's own Talk action): surface the
 * main window — recreating it if the user closed it — then dispatch the
 * `openVoice` command, which the renderer routes to the voice surface.
 * Awaiting `ensureVisible` matters: it resolves only after the renderer has
 * finished loading, so the command isn't dropped by a freshly created window.
 */
export const talkToCue = async (): Promise<void> => {
  await ensureMainWindowVisible();
  dispatchToMain({ kind: "openVoice" });
};

/**
 * "Open Cue": surface (or recreate) the main window.
 */
export const openCueFromCompanion = async (): Promise<void> => {
  await ensureMainWindowVisible();
};

let installed = false;

/**
 * Register the companion IPC surface and reconcile the window with the
 * persisted flag state. Call once from `whenReady` (after
 * `installStatusIpc`, so status pushes reflect renderer publishes).
 * Idempotent under dev hot-reload like the other `installX` modules.
 *
 * With the flag off this is inert beyond channel registration: no window
 * is created, and the handlers no-op against the absent singleton.
 */
export const installCompanionWindow = (): void => {
  if (installed) return;
  installed = true;

  handle("vellum:companion:setPointerOver", z.tuple([z.boolean()]), ([over]) => {
    setCompanionPointerOver(over);
  });

  handle("vellum:companion:dragBegin", z.tuple([]), () => {
    beginCompanionDrag();
  });

  handle("vellum:companion:dragEnd", z.tuple([]), () => {
    endCompanionDrag();
  });

  handle(
    "vellum:companion:setSize",
    z.tuple([z.enum(COMPANION_SIZES)]),
    ([size]) => {
      setCompanionSize(size);
    },
  );

  handle("vellum:companion:getState", z.tuple([]), () => companionState());

  on("vellum:companion:signals", z.tuple([signalsSchema]), ([patch]) => {
    void applyCompanionSignals(patch);
  });

  handle("vellum:companion:menu", z.tuple([]), () => {
    popCompanionMenu();
  });

  // The press names the beat it was made against — see `companion-intro.ts`.
  handle("vellum:companion:introNext", z.tuple([z.number()]), ([fromBeat]) => {
    if (intro?.next(fromBeat)) afterCardRemoved();
  });

  handle("vellum:companion:introDismiss", z.tuple([]), () => {
    if (intro?.dismiss()) afterCardRemoved();
  });

  handle(
    "vellum:companion:nudge",
    z.tuple([
      z.object({
        itemId: z.string(),
        line: z.string(),
        source: z.string(),
        subject: z
          .object({
            kind: z.enum(["sender", "channel", "rule"]),
            key: z.string(),
          })
          .optional(),
      }),
    ]),
    ([request]) => offerCompanionNudge(request),
  );

  // One line, one Open, one ✕ — a nudge never carries buttons that act, so a
  // stray click cannot approve anything (`C7`, and `C9`'s protocol).
  handle("vellum:companion:nudgeOpen", z.tuple([]), async () => {
    const itemId = nudges?.open() ?? null;
    afterCardRemoved();
    if (!itemId) return;
    await ensureMainWindowVisible();
    dispatchToMain({ kind: "openNeedsYouItem", itemId });
  });

  /**
   * A drag is passing over the creature (`C10`).
   *
   * The arc opens toward it — the character gesture and the affordance are
   * the same thing, so this is published as a creature attribute rather than
   * a phase and works in the middle of whatever else is true.
   */
  handle("vellum:companion:dragOver", z.tuple([z.boolean()]), ([over]) => {
    if (opening === over) return;
    opening = over;
    publishState();
  });

  handle(
    "vellum:companion:drop",
    z.tuple([
      z.object({
        kind: z.enum(["file", "image", "url", "text"]),
        value: z.string(),
      }),
    ]),
    ([item]) => {
      opening = false;
      drops?.catch(describeDrop(item), item.value);
    },
  );

  handle(
    "vellum:companion:dropChoose",
    z.tuple([z.enum(["read", "file", "note"])]),
    ([choice]) => {
      drops?.choose(choice as DropChoice);
    },
  );

  handle("vellum:companion:dropRelease", z.tuple([]), () => {
    drops?.release();
  });

  /**
   * The typing card's two verbs (`C2`, `Q1`).
   *
   * Both hand off rather than acting here, which is the same rule the whole
   * surface obeys: the companion talks, and the app acts. The card is one
   * exchange and never grows a thread, so there is nothing here that needs
   * somewhere to put a conversation.
   */
  handle("vellum:companion:ask", z.tuple([z.string()]), async ([message]) => {
    const text = message.trim();
    if (!text) return;
    phases?.set({ typing: false });
    afterCardRemoved();
    await ensureMainWindowVisible();
    dispatchToMain({ kind: "quickInputSubmit", message: text });
  });

  handle(
    "vellum:companion:keepAsNote",
    z.tuple([z.string()]),
    async ([note]) => {
      const text = note.trim();
      if (!text) return;
      phases?.set({ typing: false });
      afterCardRemoved();
      await ensureMainWindowVisible();
      dispatchToMain({ kind: "newNote", text });
    },
  );

  /** `esc`, and the summon pressed a second time. Cancels nothing. */
  handle("vellum:companion:closeCard", z.tuple([]), () => {
    phases?.set({ typing: false });
    afterCardRemoved();
  });

  handle("vellum:companion:nudgeDismiss", z.tuple([]), () => {
    nudges?.dismiss();
    afterCardRemoved();
  });

  handle("vellum:companion:talk", z.tuple([]), async () => {
    await talkToCue();
  });

  handle("vellum:companion:openCue", z.tuple([]), async () => {
    await openCueFromCompanion();
  });

  handle("vellum:companion:hide", z.tuple([]), () => {
    if (captureLive()) return;
    writeSetting("companionVisible", false);
    syncCompanionWindow();
  });

  /**
   * The pill's `Stop`, in every phase that has one.
   *
   * What it stops depends on what is running, and main is the only side that
   * knows: a capture is stopped at its source, and a run in progress is
   * cancelled. Deciding this in the renderer would mean the button's meaning
   * came from a phase the renderer might be one message behind on.
   */
  handle("vellum:companion:stop", z.tuple([]), async () => {
    if (captureLive()) {
      await stopCompanionCapture();
      return;
    }
    dispatchToMain({ kind: "cancelActiveAction" });
  });

  // The tray's assistant-status state machine is the source for whose turn
  // it is. It reaches the creature as a *phase*, resolved here — the
  // companion used to also receive the raw status on its own channel and
  // outrank it in the renderer, which is one question with two answers.
  onStatusChange(() => {
    phases?.set({ busy: getStatus() === "thinking" });
  });

  // A display arriving or leaving, or the menu bar changing height, moves the
  // work area under a surface that never moved — which can flip which way
  // there is room to unfurl. Re-place rather than only re-decide.
  screen.on("display-metrics-changed", () => placement?.refresh());
  screen.on("display-added", () => placement?.refresh());
  screen.on("display-removed", () => placement?.refresh());

  // The renderer publishes flag values after sign-in / flag toggles; the
  // persisted map is also available at startup from the previous session.
  onSettingChange("featureFlags", () => {
    syncCompanionWindow();
  });

  // Signing in is what brings the creature out; signing out takes it away
  // again rather than leaving a signed-out surface floating over the desktop.
  onSignedInChange(() => {
    syncCompanionWindow();
  });
  syncCompanionWindow();
};

// Test seam — exported only for unit-test setup. Production code uses
// `installCompanionWindow` instead.
export const __resetForTesting = (): void => {
  installed = false;
  stopDragPoll();
  stopProximityPoll();
  nudges?.stop();
  nudges = null;
  drops?.stop();
  drops = null;
  caught = null;
  opening = false;
  pointerOverDrawn = false;
  cursorOnCreature = false;
  heldNudge = null;
  placement = null;
  phases = null;
  intro = null;
  hitTest = null;
  drag = null;
};

/**
 * Re-exported so the tray keeps importing its gate from the window it gates.
 * The logic itself lives in `desktop-surface-flags` — see that file for why.
 */
export { isCompanionEnabled };
