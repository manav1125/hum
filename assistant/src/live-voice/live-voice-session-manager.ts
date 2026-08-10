import { randomUUID } from "node:crypto";

import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientFrame,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

type MaybePromise<T> = T | Promise<T>;

export type LiveVoiceSessionCloseReason =
  | "client_end"
  | "error"
  | "websocket_close"
  // A newer `start` preempted this session (newest-wins admission).
  | "superseded"
  // The manager's client-liveness bound fired: no client frames arrived for
  // the configured window, so the session was reaped server-side.
  | "client_inactivity"
  | "manager_shutdown";

/**
 * Terminal error message delivered (best-effort) to a session's client when a
 * newer `start` takes over the single live-voice slot.
 */
export const LIVE_VOICE_TAKEN_OVER_MESSAGE =
  "This call was taken over by a newer session.";

/**
 * Terminal error message delivered (best-effort) to a session's client when
 * the client-liveness bound reaps the session. Usually the socket behind it is
 * already dead — the send is honesty for the rare still-listening client.
 */
export const LIVE_VOICE_CLIENT_INACTIVITY_MESSAGE =
  "This call was closed because no audio or input arrived from your device.";

/**
 * Default client-liveness bound: a session that receives NO client frames
 * (audio, text or control) for this long is closed server-side. Applies to
 * every engine at the manager level — the cascade's own 120s idle timer will
 * usually fire first for cascade sessions; this is the backstop that also
 * covers engines (gemini-live) with no internal inactivity bound.
 */
export const LIVE_VOICE_CLIENT_INACTIVITY_TIMEOUT_MS = 180_000;

/**
 * Default bound on the graceful teardown of a preempted session. After this,
 * the wedged registration is force-dropped (its close keeps running detached)
 * so a stuck old session can never stall admission of the new one.
 */
export const LIVE_VOICE_PREEMPT_TEARDOWN_TIMEOUT_MS = 2_000;

export interface LiveVoiceSession {
  start(): MaybePromise<void>;
  handleClientFrame(frame: LiveVoiceClientFrame): MaybePromise<void>;
  handleBinaryAudio(chunk: Uint8Array): MaybePromise<void>;
  close(reason: LiveVoiceSessionCloseReason): MaybePromise<void>;
}

export interface LiveVoiceServerFrameSink {
  sendFrame(frame: LiveVoiceServerFrame): MaybePromise<void>;
}

export interface LiveVoiceSessionFactoryContext {
  sessionId: string;
  startFrame: LiveVoiceClientStartFrame;
  sendFrame(frame: LiveVoiceServerFramePayload): Promise<LiveVoiceServerFrame>;
}

export type LiveVoiceSessionFactory = (
  context: LiveVoiceSessionFactoryContext,
) => LiveVoiceSession;

export interface LiveVoiceSessionManagerOptions {
  createSession: LiveVoiceSessionFactory;
  createSessionId?: () => string;
  /**
   * Overrides {@link LIVE_VOICE_PREEMPT_TEARDOWN_TIMEOUT_MS} (tests use small
   * values so a wedged-teardown scenario completes quickly).
   */
  preemptTeardownTimeoutMs?: number;
  /**
   * Overrides {@link LIVE_VOICE_CLIENT_INACTIVITY_TIMEOUT_MS}.
   */
  clientInactivityTimeoutMs?: number;
}

export class LiveVoiceSessionStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveVoiceSessionStartupError";
  }
}

export type LiveVoiceStartSessionResult =
  | {
      status: "accepted";
      sessionId: string;
    }
  | {
      status: "failed";
      sessionId: string;
    };

export type LiveVoiceSessionDispatchResult =
  | {
      status: "handled";
      sessionId: string;
    }
  | {
      status: "not_found";
    };

export type LiveVoiceSessionReleaseResult =
  | {
      released: true;
      sessionId: string;
    }
  | {
      released: false;
    };

interface ActiveLiveVoiceSession {
  sessionId: string;
  session: LiveVoiceSession;
  closing: boolean;
  /** The session's own sequenced frame channel (for terminal error frames). */
  sendFrame: (
    payload: LiveVoiceServerFramePayload,
  ) => Promise<LiveVoiceServerFrame>;
  /** Timestamp of the most recent client frame (any kind), for liveness. */
  lastClientFrameAt: number;
  livenessTimer: ReturnType<typeof setTimeout> | null;
}

export class LiveVoiceSessionManager {
  private readonly createSession: LiveVoiceSessionFactory;
  private readonly createSessionId: () => string;
  private readonly preemptTeardownTimeoutMs: number;
  private readonly clientInactivityTimeoutMs: number;
  private activeSession: ActiveLiveVoiceSession | null = null;
  /**
   * Serializes admissions so overlapping starts preempt in arrival order:
   * each start closes whatever is active when its turn comes, so the newest
   * start always ends up owning the slot.
   */
  private admissionChain: Promise<unknown> = Promise.resolve();

  constructor(options: LiveVoiceSessionManagerOptions) {
    this.createSession = options.createSession;
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.preemptTeardownTimeoutMs =
      options.preemptTeardownTimeoutMs ??
      LIVE_VOICE_PREEMPT_TEARDOWN_TIMEOUT_MS;
    this.clientInactivityTimeoutMs =
      options.clientInactivityTimeoutMs ??
      LIVE_VOICE_CLIENT_INACTIVITY_TIMEOUT_MS;
  }

  get activeSessionId(): string | null {
    return this.activeSession?.sessionId ?? null;
  }

  /**
   * Admit a session for the incoming `start` frame. Newest wins: if a session
   * is already active — including one whose client vanished without a socket
   * close — it is closed gracefully (terminal takeover error frame, normal
   * finalize path) and the new session takes the slot. A `busy` rejection is
   * never sent.
   */
  async startSession(
    startFrame: LiveVoiceClientStartFrame,
    sink: LiveVoiceServerFrameSink,
  ): Promise<LiveVoiceStartSessionResult> {
    const admission = this.admissionChain.then(() =>
      this.admitSession(startFrame, sink),
    );
    // The chain must survive an admission rejection, and a failed admission
    // is surfaced to this caller only (via `await admission` below).
    this.admissionChain = admission.then(
      () => undefined,
      () => undefined,
    );
    const active = await admission;

    try {
      await active.session.start();
    } catch (err) {
      await this.releaseAfterSessionError(active.sessionId);
      if (err instanceof LiveVoiceSessionStartupError) {
        return { status: "failed", sessionId: active.sessionId };
      }
      throw err;
    }

    return { status: "accepted", sessionId: active.sessionId };
  }

  async handleClientFrame(
    sessionId: string,
    frame: LiveVoiceClientFrame,
  ): Promise<LiveVoiceSessionDispatchResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { status: "not_found" };
    }
    active.lastClientFrameAt = Date.now();

    try {
      await active.session.handleClientFrame(frame);
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      throw err;
    }

    if (frame.type === "end") {
      await this.releaseSession(sessionId, "client_end");
    }

    return { status: "handled", sessionId };
  }

  async handleBinaryAudio(
    sessionId: string,
    chunk: Uint8Array,
  ): Promise<LiveVoiceSessionDispatchResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { status: "not_found" };
    }
    active.lastClientFrameAt = Date.now();

    try {
      await active.session.handleBinaryAudio(chunk);
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      throw err;
    }

    return { status: "handled", sessionId };
  }

  async releaseSession(
    sessionId: string,
    reason: LiveVoiceSessionCloseReason = "websocket_close",
  ): Promise<LiveVoiceSessionReleaseResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { released: false };
    }

    active.closing = true;
    this.clearLivenessTimer(active);
    try {
      await active.session.close(reason);
    } finally {
      if (this.activeSession === active) {
        this.activeSession = null;
      }
    }
    return { released: true, sessionId };
  }

  private async admitSession(
    startFrame: LiveVoiceClientStartFrame,
    sink: LiveVoiceServerFrameSink,
  ): Promise<ActiveLiveVoiceSession> {
    const existing = this.activeSession;
    if (existing !== null) {
      await this.preemptSession(existing);
    }

    const sessionId = this.createSessionId();
    const sequencer = createLiveVoiceServerFrameSequencer();
    const context: LiveVoiceSessionFactoryContext = {
      sessionId,
      startFrame,
      sendFrame: async (payload) => {
        const frame = sequencer.next(payload);
        await sink.sendFrame(frame);
        return frame;
      },
    };
    const session = this.createSession(context);
    const active: ActiveLiveVoiceSession = {
      sessionId,
      session,
      closing: false,
      sendFrame: context.sendFrame,
      lastClientFrameAt: Date.now(),
      livenessTimer: null,
    };
    this.activeSession = active;
    this.scheduleLivenessCheck(active);
    return active;
  }

  /**
   * Newest-wins preemption: close the currently active session so an incoming
   * `start` can take the slot. The old session's client — if any is still
   * listening — gets a terminal takeover error frame, and the normal close
   * path runs so end-of-session finalize work happens exactly as on a clean
   * close. Teardown is bounded: after {@link preemptTeardownTimeoutMs} the
   * registration is force-dropped (the close keeps running detached) so a
   * wedged old session can never stall admission of the new one.
   */
  private async preemptSession(active: ActiveLiveVoiceSession): Promise<void> {
    if (active.closing) {
      // A close is already in flight (client end / socket close raced the new
      // start). Detach the registration so the new session can be admitted
      // now; the in-flight close's cleanup only clears the slot if it still
      // owns it, so a late completion cannot clobber the new session.
      this.clearLivenessTimer(active);
      if (this.activeSession === active) {
        this.activeSession = null;
      }
      return;
    }

    try {
      await active.sendFrame({
        type: "error",
        code: "invalid_frame",
        message: LIVE_VOICE_TAKEN_OVER_MESSAGE,
        fatal: true,
      });
    } catch {
      // The old client is often already gone — that is the exact zombie case
      // preemption exists for. Delivery is best-effort.
    }

    const teardown = this.releaseSession(active.sessionId, "superseded").then(
      () => undefined,
      // A close failure must not block admission; releaseSession's own
      // cleanup already dropped the registration.
      () => undefined,
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      teardown.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.preemptTeardownTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (timedOut) {
      // Wedged teardown: force-drop the registration and let the close finish
      // (or hang) detached. releaseSession's cleanup checks identity before
      // clearing the slot, so a late completion cannot clobber the new
      // session admitted after this.
      this.clearLivenessTimer(active);
      if (this.activeSession === active) {
        this.activeSession = null;
      }
    }
  }

  /**
   * Engine-agnostic client-liveness bound: a session that has received no
   * client frames at all — audio, text or control — for
   * {@link clientInactivityTimeoutMs} is closed server-side with an honest
   * terminal error frame plus the normal finalize path. This is the guard
   * against a client that vanished without a socket close (killed app,
   * network drop the TCP stack never surfaced) holding the single live-voice
   * slot forever.
   *
   * The timer is scheduled for the remaining window and re-derived from
   * `lastClientFrameAt` when it fires, so frame handling stays a cheap
   * timestamp write instead of a per-audio-chunk timer reset.
   */
  private scheduleLivenessCheck(active: ActiveLiveVoiceSession): void {
    if (this.activeSession !== active || active.closing) {
      return;
    }
    const elapsed = Date.now() - active.lastClientFrameAt;
    const remaining = this.clientInactivityTimeoutMs - elapsed;
    if (remaining <= 0) {
      void this.reapInactiveSession(active);
      return;
    }
    active.livenessTimer = setTimeout(() => {
      active.livenessTimer = null;
      this.scheduleLivenessCheck(active);
    }, remaining);
    active.livenessTimer.unref?.();
  }

  private async reapInactiveSession(
    active: ActiveLiveVoiceSession,
  ): Promise<void> {
    if (this.activeSession !== active || active.closing) {
      return;
    }
    try {
      await active.sendFrame({
        type: "error",
        code: "invalid_frame",
        message: LIVE_VOICE_CLIENT_INACTIVITY_MESSAGE,
        fatal: true,
      });
    } catch {
      // The socket is usually already dead — that is why we are reaping.
    }
    try {
      await this.releaseSession(active.sessionId, "client_inactivity");
    } catch {
      // Reaping runs from a timer; a close failure has nowhere to surface.
    }
  }

  private clearLivenessTimer(active: ActiveLiveVoiceSession): void {
    if (active.livenessTimer !== null) {
      clearTimeout(active.livenessTimer);
      active.livenessTimer = null;
    }
  }

  private findActiveSession(sessionId: string): ActiveLiveVoiceSession | null {
    const active = this.activeSession;
    if (active === null || active.sessionId !== sessionId || active.closing) {
      return null;
    }

    return active;
  }

  private async releaseAfterSessionError(sessionId: string): Promise<void> {
    try {
      await this.releaseSession(sessionId, "error");
    } catch {
      // The original session error is more useful to callers than a cleanup error.
    }
  }
}
