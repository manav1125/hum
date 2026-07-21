/**
 * Cue Live screen-stream state machine (Mac → daemon → web viewer).
 *
 * The remote viewer used to be metadata-only. It now shows the real screen,
 * which makes this the most privacy-sensitive path in the product: a frame can
 * contain anything that is on the owner's display. Three rules hold the line,
 * and they are enforced here rather than by convention:
 *
 * 1. **Ephemeral.** Exactly ONE frame is held, in a module-level variable, and
 *    it is overwritten by the next push. Frames are never written to the
 *    database, never written to disk, and never appended to an event stream.
 *    A daemon restart forgets everything, which is the honest outcome.
 * 2. **Opt-in.** Nothing is captured until the stream is explicitly armed by
 *    the owner (from the web viewer or from the Mac). Opening the viewer does
 *    not arm it. A push that arrives while disarmed is dropped and the pusher
 *    is told to stop.
 * 3. **Stoppable, and it stops itself.** Either side can disarm. On top of
 *    that the stream is *viewer-driven*: `takeFrame` records that somebody is
 *    watching, and a stream nobody has read from for
 *    {@link VIEWER_TIMEOUT_MS} disarms on its own. Closing the browser tab
 *    stops the camera without anybody pressing stop.
 *
 * Bandwidth is negotiated in the push response rather than fixed: the daemon
 * measures what the last frames actually cost and hands the Mac back a frame
 * interval and a downscale width that keep the stream inside
 * {@link TARGET_BYTES_PER_SEC}. Start is ~1.4 fps and it backs off to 0.33 fps
 * for expensive (large, busy) screens.
 */

/** A pushed frame older than this is not served and does not count as live. */
const FRAME_TTL_MS = 8_000;
/** Armed but nothing pushed for this long → `stalled` (Mac went away). */
const STALE_MS = 6_000;
/** Armed but nobody has read a frame for this long → auto-disarm. */
const VIEWER_TIMEOUT_MS = 20_000;
/** A Mac that hasn't checked in for this long is treated as gone. */
const MAC_PRESENCE_MS = 15_000;
/** Hard ceiling on one frame's base64 payload (~700 KB of image bytes). */
export const MAX_FRAME_BASE64_BYTES = 950_000;
/** Bandwidth target the push interval is negotiated against. */
const TARGET_BYTES_PER_SEC = 110_000;
/** Push interval bounds: ~2 fps at best, ~0.33 fps at worst. */
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 3_000;
/** Downscale widths the daemon may ask the Mac for. */
const MAX_CAPTURE_WIDTH = 1280;
const MIN_CAPTURE_WIDTH = 720;

export type CueLiveStreamOrigin = "web" | "mac";

/**
 * - `off` — not armed; nothing is being captured.
 * - `starting` — armed, no fresh frame has arrived yet.
 * - `live` — armed and a frame arrived within {@link FRAME_TTL_MS}.
 * - `stalled` — armed but the Mac stopped pushing (asleep, quit, no grant).
 */
export type CueLiveStreamState = "off" | "starting" | "live" | "stalled";

export interface CueLiveFrame {
  /** Base64 image bytes, no data-URI prefix. Never persisted. */
  dataBase64: string;
  mediaType: string;
  /** Frame pixel size — the coordinate space web input arrives in. */
  width: number;
  height: number;
  /** Screen size in points — the space host CU actions are performed in. */
  screenWidth: number;
  screenHeight: number;
  appName: string | null;
  capturedAt: string;
  /** Monotonic per-arm counter, so the viewer can tell frames apart. */
  seq: number;
}

/**
 * What the Mac told us on its last check-in. Without this a stopped stream and
 * an unreachable Mac look identical in the viewer, and the user gets a spinner
 * instead of the reason.
 */
export interface CueLiveMacPresence {
  seenAt: string;
  cueLiveRunning: boolean;
  screenRecordingGranted: boolean;
  deviceName: string | null;
}

export interface CueLiveStreamStatus {
  state: CueLiveStreamState;
  /** True while the stream is armed, whatever the Mac is doing. */
  armed: boolean;
  /** Who armed it, for the "you started this" line on both surfaces. */
  armedBy: CueLiveStreamOrigin | null;
  armedAt: string | null;
  lastFrameAt: string | null;
  /** Sequence number of the frame currently held (0 when none). */
  seq: number;
  /** What the Mac should wait between pushes right now. */
  intervalMs: number;
  /** Longest edge the Mac should downscale to before encoding. */
  maxWidth: number;
  /** True when a viewer has read a frame recently. */
  viewerAttached: boolean;
  /** Set when the stream stopped on its own, so the UI can say why. */
  lastStopReason: string | null;
  /** Null when the Mac hasn't checked in recently — it may be asleep or quit. */
  mac: CueLiveMacPresence | null;
}

interface StreamState {
  armed: boolean;
  armedBy: CueLiveStreamOrigin | null;
  armedAtMs: number | null;
  frame: CueLiveFrame | null;
  lastFrameMs: number | null;
  lastViewerReadMs: number | null;
  seq: number;
  intervalMs: number;
  maxWidth: number;
  lastStopReason: string | null;
  mac: CueLiveMacPresence | null;
  macSeenMs: number | null;
}

function freshState(): StreamState {
  return {
    armed: false,
    armedBy: null,
    armedAtMs: null,
    frame: null,
    lastFrameMs: null,
    lastViewerReadMs: null,
    seq: 0,
    intervalMs: 700,
    maxWidth: MAX_CAPTURE_WIDTH,
    lastStopReason: null,
    mac: null,
    macSeenMs: null,
  };
}

let state: StreamState = freshState();

/** Drop the held frame. Called on every path that ends or pauses the stream. */
function dropFrame(): void {
  state.frame = null;
  state.lastFrameMs = null;
}

/**
 * Auto-disarm when the last reader went away. Called at the top of every
 * accessor so the timeout fires without a timer (the daemon must not hold a
 * background job open for a screen stream).
 */
function expireIfUnwatched(now: number): void {
  if (!state.armed) return;
  // Grace period: the arm itself counts as attention until the first read.
  const lastAttention =
    state.lastViewerReadMs ?? state.armedAtMs ?? now;
  if (now - lastAttention > VIEWER_TIMEOUT_MS) {
    state.armed = false;
    state.armedBy = null;
    state.armedAtMs = null;
    state.lastViewerReadMs = null;
    state.lastStopReason = "Stopped — nobody was watching.";
    dropFrame();
  }
}

function resolveState(now: number): CueLiveStreamState {
  if (!state.armed) return "off";
  if (state.lastFrameMs !== null && now - state.lastFrameMs <= FRAME_TTL_MS) {
    return "live";
  }
  const since = state.lastFrameMs ?? state.armedAtMs ?? now;
  return now - since > STALE_MS ? "stalled" : "starting";
}

function status(now: number): CueLiveStreamStatus {
  const resolved = resolveState(now);
  return {
    state: resolved,
    armed: state.armed,
    armedBy: state.armedBy,
    armedAt:
      state.armedAtMs !== null ? new Date(state.armedAtMs).toISOString() : null,
    lastFrameAt:
      state.lastFrameMs !== null
        ? new Date(state.lastFrameMs).toISOString()
        : null,
    seq: state.frame?.seq ?? 0,
    intervalMs: state.intervalMs,
    maxWidth: state.maxWidth,
    viewerAttached:
      state.lastViewerReadMs !== null &&
      now - state.lastViewerReadMs <= VIEWER_TIMEOUT_MS,
    lastStopReason: state.lastStopReason,
    mac:
      state.macSeenMs !== null && now - state.macSeenMs <= MAC_PRESENCE_MS
        ? state.mac
        : null,
  };
}

/**
 * Record a Mac check-in. This is the Mac's only control channel: it learns
 * from the response whether the owner armed the stream, and it never captures
 * anything until that response says so.
 */
export function recordMacCheckin(
  input: {
    cueLiveRunning: boolean;
    screenRecordingGranted: boolean;
    deviceName?: string | null;
  },
  now: number = Date.now(),
): CueLiveStreamStatus {
  state.macSeenMs = now;
  state.mac = {
    seenAt: new Date(now).toISOString(),
    cueLiveRunning: input.cueLiveRunning,
    screenRecordingGranted: input.screenRecordingGranted,
    deviceName: input.deviceName?.trim() || null,
  };
  // A Mac that can no longer capture must not leave the viewer waiting on a
  // picture that will never arrive.
  if (state.armed && (!input.cueLiveRunning || !input.screenRecordingGranted)) {
    disarmStream("mac", now);
    state.lastStopReason = !input.cueLiveRunning
      ? "Stopped — Cue Live isn't running on your Mac."
      : "Stopped — your Mac no longer has Screen Recording permission.";
  }
  return getStreamStatus(now);
}

/** Arm the stream. Idempotent — re-arming refreshes the watch clock. */
export function armStream(
  origin: CueLiveStreamOrigin,
  now: number = Date.now(),
): CueLiveStreamStatus {
  if (!state.armed) {
    state.seq = 0;
    state.intervalMs = 700;
    state.maxWidth = MAX_CAPTURE_WIDTH;
  }
  state.armed = true;
  state.armedBy = origin;
  state.armedAtMs = state.armedAtMs ?? now;
  state.lastViewerReadMs = origin === "web" ? now : state.lastViewerReadMs;
  state.lastStopReason = null;
  return status(now);
}

/**
 * Disarm and drop the held frame. `reason` is shown on both surfaces so a stop
 * from the other device never looks like a glitch.
 */
export function disarmStream(
  origin: CueLiveStreamOrigin,
  now: number = Date.now(),
): CueLiveStreamStatus {
  const wasArmed = state.armed;
  state.armed = false;
  state.armedBy = null;
  state.armedAtMs = null;
  state.lastViewerReadMs = null;
  state.lastStopReason = wasArmed
    ? origin === "mac"
      ? "Stopped on your Mac."
      : "Stopped from the web viewer."
    : state.lastStopReason;
  dropFrame();
  return status(now);
}

export interface PushFrameInput {
  dataBase64: string;
  mediaType: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  appName?: string | null;
}

export interface PushFrameResult {
  /** False tells the Mac to stop capturing immediately. */
  streaming: boolean;
  /** How long to wait before the next push. */
  intervalMs: number;
  /** Longest edge to downscale to before encoding the next frame. */
  maxWidth: number;
  /** Present when the frame was refused, so the Mac can log the truth. */
  rejected?: string;
}

/**
 * Accept one frame from the Mac. Replaces whatever was held; nothing is
 * appended, queued, or written anywhere. Returns the negotiated cadence — the
 * Mac obeys it, so bandwidth control lives on the daemon side where the frame
 * cost is actually measured.
 */
export function pushFrame(
  input: PushFrameInput,
  now: number = Date.now(),
): PushFrameResult {
  expireIfUnwatched(now);
  if (!state.armed) {
    dropFrame();
    return { streaming: false, intervalMs: state.intervalMs, maxWidth: state.maxWidth };
  }
  if (input.dataBase64.length > MAX_FRAME_BASE64_BYTES) {
    // Refuse rather than truncate, and ask for a smaller capture next time.
    state.maxWidth = MIN_CAPTURE_WIDTH;
    state.intervalMs = MAX_INTERVAL_MS;
    return {
      streaming: true,
      intervalMs: state.intervalMs,
      maxWidth: state.maxWidth,
      rejected: "frame too large",
    };
  }

  state.seq += 1;
  state.frame = {
    dataBase64: input.dataBase64,
    mediaType: input.mediaType,
    width: input.width,
    height: input.height,
    screenWidth: input.screenWidth,
    screenHeight: input.screenHeight,
    appName: input.appName?.trim() || null,
    capturedAt: new Date(now).toISOString(),
    seq: state.seq,
  };
  state.lastFrameMs = now;

  // Bandwidth-aware cadence: base64 is 4/3 of the wire bytes.
  const bytes = Math.round((input.dataBase64.length * 3) / 4);
  const interval = Math.round((bytes / TARGET_BYTES_PER_SEC) * 1000);
  state.intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(MIN_INTERVAL_MS, interval),
  );
  state.maxWidth =
    state.intervalMs >= MAX_INTERVAL_MS ? MIN_CAPTURE_WIDTH : MAX_CAPTURE_WIDTH;

  return {
    streaming: true,
    intervalMs: state.intervalMs,
    maxWidth: state.maxWidth,
  };
}

export interface TakeFrameResult {
  status: CueLiveStreamStatus;
  /** Null whenever the stream is off, starting, stalled, or the frame aged out. */
  frame: CueLiveFrame | null;
}

/**
 * Read the held frame for a viewer. Records the read (this is what keeps the
 * stream alive) and refuses to serve a frame older than {@link FRAME_TTL_MS}
 * so a frozen picture can never be mistaken for a live screen.
 */
export function takeFrame(now: number = Date.now()): TakeFrameResult {
  expireIfUnwatched(now);
  if (state.armed) state.lastViewerReadMs = now;
  const fresh =
    state.frame !== null &&
    state.lastFrameMs !== null &&
    now - state.lastFrameMs <= FRAME_TTL_MS;
  if (!fresh) dropFrame();
  return { status: status(now), frame: fresh ? state.frame : null };
}

/** Status without counting as a viewer read (used by the Mac's control poll). */
export function getStreamStatus(
  now: number = Date.now(),
): CueLiveStreamStatus {
  expireIfUnwatched(now);
  return status(now);
}

export interface FrameGeometry {
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

/**
 * Geometry of the frame the viewer is currently looking at, for mapping a web
 * click in frame pixels onto screen points. Null when there is no live frame —
 * which is exactly when input must be refused, since the operator would be
 * clicking at a screen they cannot see.
 */
export function getLiveFrameGeometry(
  now: number = Date.now(),
): FrameGeometry | null {
  if (resolveState(now) !== "live" || !state.frame) return null;
  const { width, height, screenWidth, screenHeight } = state.frame;
  if (width <= 0 || height <= 0) return null;
  return { width, height, screenWidth, screenHeight };
}

/** Test-only: wipe the module-level stream state. */
export function resetCueLiveStreamForTest(): void {
  state = freshState();
}

export const __testing = {
  FRAME_TTL_MS,
  STALE_MS,
  VIEWER_TIMEOUT_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
};
