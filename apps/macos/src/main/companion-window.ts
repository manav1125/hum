import { screen, type BrowserWindow } from "electron";
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
import { onSettingChange, readSetting, writeSetting } from "./settings";
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
export const isCompanionVisible = (): boolean =>
  readSetting("companionVisible") ?? true;

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
  return {
    ...resolved,
    avatarBox: geometry.avatarBox,
    growth: current?.growth ?? "right",
    cardGrowth: current?.cardGrowth ?? "up",
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
    setInteractive: (interactive) => hitTest?.set(interactive),
  });

  // Transparent to clicks from the very first frame, while still receiving
  // mouse-move. A new window that claimed its canvas would swallow presses
  // before anything had even been drawn.
  hitTest.install();
  placement.moveTo(startingCentre(size));

  // The route chunk loads lazily; publish once the renderer is ready so the
  // creature doesn't wait for the next thing to change.
  win.webContents.on("did-finish-load", () => {
    publishState();
  });

  win.on("blur", abandonDrag);
  win.on("closed", () => {
    abandonDrag();
    placement = null;
    phases = null;
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
  hitTest?.set(over);
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
  const shouldShow = isCompanionEnabled() && isCompanionVisible();
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

  handle("vellum:companion:talk", z.tuple([]), async () => {
    await talkToCue();
  });

  handle("vellum:companion:openCue", z.tuple([]), async () => {
    await openCueFromCompanion();
  });

  handle("vellum:companion:hide", z.tuple([]), () => {
    writeSetting("companionVisible", false);
    syncCompanionWindow();
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
  syncCompanionWindow();
};

// Test seam — exported only for unit-test setup. Production code uses
// `installCompanionWindow` instead.
export const __resetForTesting = (): void => {
  installed = false;
  stopDragPoll();
  placement = null;
  phases = null;
  hitTest = null;
  drag = null;
};

/**
 * Re-exported so the tray keeps importing its gate from the window it gates.
 * The logic itself lives in `desktop-surface-flags` — see that file for why.
 */
export { isCompanionEnabled };
