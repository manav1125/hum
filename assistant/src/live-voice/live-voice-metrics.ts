export type LiveVoiceMetricsClock = () => number;

export type LiveVoiceMetricsEvent =
  | "session_started"
  | "session_ready"
  | "turn_started"
  | "first_audio"
  | "assistant_dispatch"
  | "first_partial"
  | "ptt_release"
  | "endpoint_decision"
  | "barge_in"
  | "final_transcript"
  | "first_assistant_delta"
  | "first_tts_audio"
  | "ack_spoken"
  | "turn_completed"
  | "turn_cancelled"
  | "session_ended";

/**
 * The endpoint outcome recorded for a silence boundary: the speculative
 * front-door leg either holds the utterance open or releases it to the turn.
 */
export type VoiceEndpointAction = "release" | "hold";

/** Semantic-endpointing decision on a silence boundary. */
interface LiveVoiceEndpointDecisionMark {
  action: VoiceEndpointAction;
  latencyMs: number;
}

type LiveVoiceTurnStatus = "active" | "completed" | "cancelled";

/**
 * Which floor-holding spoken acknowledgement actually spoke during a turn.
 * `first_delta` = the assistant was slow to produce its first spoken delta;
 * `tool_use` = the turn started a (guaranteed-slow) tool call. Turns that
 * never needed an ack leave this `null`.
 */
export type LiveVoiceSpokenAckKind = "first_delta" | "tool_use";

interface LiveVoiceMetricsCollectorOptions {
  sessionId: string;
  conversationId?: string;
  clock?: LiveVoiceMetricsClock;
  emit?: (frame: LiveVoiceMetricsFrame) => void;
  recentTurnLimit?: number;
}

interface LiveVoiceSessionMetrics {
  sessionId: string;
  conversationId?: string;
  startedAtMs: number;
  readyAtMs: number | null;
  startToReadyMs: number | null;
}

interface LiveVoiceTurnTimestamps {
  startedAtMs: number;
  firstAudioAtMs: number | null;
  firstPartialAtMs: number | null;
  pttReleaseAtMs: number | null;
  bargeInAtMs: number | null;
  finalTranscriptAtMs: number | null;
  // First assistant-leg dispatch of the turn (first-wins across hold
  // replays): the moment the felt-latency clock starts, unlike
  // finalTranscriptAtMs which can predate the boundary by the caller's
  // whole multi-segment utterance.
  assistantDispatchAtMs: number | null;
  firstAssistantDeltaAtMs: number | null;
  firstTtsAudioAtMs: number | null;
  completedAtMs: number | null;
  cancelledAtMs: number | null;
}

interface LiveVoiceTurnDurations {
  firstAudioToFirstPartialMs: number | null;
  pttReleaseToFinalTranscriptMs: number | null;
  finalTranscriptToFirstAssistantDeltaMs: number | null;
  // Dispatch-anchored versions: what the leg (and the caller's ear) actually
  // waited, immune to final-transcript anchor inflation on multi-segment
  // utterances.
  dispatchToFirstAssistantDeltaMs: number | null;
  dispatchToFirstTtsAudioMs: number | null;
  firstAssistantDeltaToFirstTtsAudioMs: number | null;
  totalTurnDurationMs: number | null;
}

interface LiveVoiceTurnMetrics {
  turnId: string;
  status: LiveVoiceTurnStatus;
  cancellationReason: string | null;
  ackSpoken: LiveVoiceSpokenAckKind | null;
  timestamps: LiveVoiceTurnTimestamps;
  durations: LiveVoiceTurnDurations;
  // Present only when the front-door endpointing was consulted for the turn,
  // so turns that never touch the feature carry no trace of it.
  endpointHoldCount?: number;
  endpointDecisionMaxLatencyMs?: number;
}

interface LiveVoiceDurationSummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

interface LiveVoiceMetricsSummary {
  retainedTurnCount: number;
  completedTurnCount: number;
  cancelledTurnCount: number;
  durations: {
    firstAudioToFirstPartialMs: LiveVoiceDurationSummary;
    pttReleaseToFinalTranscriptMs: LiveVoiceDurationSummary;
    finalTranscriptToFirstAssistantDeltaMs: LiveVoiceDurationSummary;
    firstAssistantDeltaToFirstTtsAudioMs: LiveVoiceDurationSummary;
    totalTurnDurationMs: LiveVoiceDurationSummary;
  };
}

interface LiveVoiceMetricsSnapshot {
  session: LiveVoiceSessionMetrics;
  activeTurn: LiveVoiceTurnMetrics | null;
  recentTurns: LiveVoiceTurnMetrics[];
  summary: LiveVoiceMetricsSummary;
}

interface LiveVoiceMetricsAggregateFields {
  sttMs: number | null;
  llmFirstDeltaMs: number | null;
  // Dispatch-anchored felt latency: leg dispatch to first delta / first TTS
  // audio, immune to the final-transcript anchor inflation llmFirstDeltaMs
  // suffers on multi-segment utterances.
  dispatchToFirstDeltaMs: number | null;
  dispatchToFirstAudioMs: number | null;
  ttsFirstAudioMs: number | null;
  totalMs: number | null;
  // Optional so metrics frames stay byte-identical when the front door never
  // engaged (see the matching fields on LiveVoiceTurnMetrics).
  endpointHoldCount?: number;
  endpointDecisionMaxLatencyMs?: number;
}

export interface LiveVoiceMetricsFrame {
  type: "metrics";
  event: LiveVoiceMetricsEvent;
  sessionId: string;
  conversationId?: string;
  turnId?: string;
  metrics: LiveVoiceMetricsSnapshot;
}

interface MutableTurn {
  turnId: string;
  status: LiveVoiceTurnStatus;
  cancellationReason: string | null;
  ackSpoken: LiveVoiceSpokenAckKind | null;
  timestamps: LiveVoiceTurnTimestamps;
  endpointHoldCount: number;
  // Doubles as the "front door was consulted" latch: null means no endpoint
  // decision was ever recorded for the turn.
  endpointDecisionMaxLatencyMs: number | null;
}

const DEFAULT_RECENT_TURN_LIMIT = 50;

export class LiveVoiceMetricsCollector {
  private readonly sessionId: string;
  private readonly conversationId?: string;
  private readonly clock: LiveVoiceMetricsClock;
  private readonly emitFrame?: (frame: LiveVoiceMetricsFrame) => void;
  private readonly recentTurnLimit: number;
  private readonly sessionStartedAtMs: number;

  private readyAtMs: number | null = null;
  private lastTimestampMs = Number.NEGATIVE_INFINITY;
  private nextTurnNumber = 1;
  private activeTurn: MutableTurn | null = null;
  private readonly recentTurns: MutableTurn[] = [];

  constructor(options: LiveVoiceMetricsCollectorOptions) {
    this.sessionId = options.sessionId;
    this.conversationId = options.conversationId;
    this.clock = options.clock ?? Date.now;
    this.emitFrame = options.emit;
    this.recentTurnLimit = normalizeRecentTurnLimit(options.recentTurnLimit);
    this.sessionStartedAtMs = this.timestamp();
    this.emit("session_started");
  }

  markReady(): LiveVoiceMetricsFrame {
    if (this.readyAtMs === null) {
      this.readyAtMs = this.timestamp();
    }
    return this.emit("session_ready");
  }

  startTurn(turnId = this.createTurnId()): LiveVoiceTurnMetrics {
    if (this.activeTurn !== null) {
      this.cancelTurn("superseded");
    }

    this.activeTurn = {
      turnId,
      status: "active",
      cancellationReason: null,
      ackSpoken: null,
      timestamps: {
        startedAtMs: this.timestamp(),
        firstAudioAtMs: null,
        firstPartialAtMs: null,
        pttReleaseAtMs: null,
        bargeInAtMs: null,
        finalTranscriptAtMs: null,
        assistantDispatchAtMs: null,
        firstAssistantDeltaAtMs: null,
        firstTtsAudioAtMs: null,
        completedAtMs: null,
        cancelledAtMs: null,
      },
      endpointHoldCount: 0,
      endpointDecisionMaxLatencyMs: null,
    };
    this.emit("turn_started", turnId);
    return snapshotTurn(this.activeTurn);
  }

  markFirstAudio(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstAudioAtMs === null) {
      turn.timestamps.firstAudioAtMs = this.timestamp();
    }
    return this.emit("first_audio", turn.turnId);
  }

  markFirstPartial(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstPartialAtMs === null) {
      turn.timestamps.firstPartialAtMs = this.timestamp();
    }
    return this.emit("first_partial", turn.turnId);
  }

  markPushToTalkRelease(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.pttReleaseAtMs === null) {
      turn.timestamps.pttReleaseAtMs = this.timestamp();
    }
    return this.emit("ptt_release", turn.turnId);
  }

  markFinalTranscript(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.finalTranscriptAtMs === null) {
      turn.timestamps.finalTranscriptAtMs = this.timestamp();
    }
    return this.emit("final_transcript", turn.turnId);
  }

  /**
   * First assistant-leg dispatch for the turn — first-wins across an
   * utterance's hold replays, so dispatch-anchored durations include the
   * hold pipeline the caller actually sat through.
   */
  markAssistantDispatch(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.assistantDispatchAtMs === null) {
      turn.timestamps.assistantDispatchAtMs = this.timestamp();
    }
    return this.emit("assistant_dispatch", turn.turnId);
  }

  markBargeIn(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.bargeInAtMs === null) {
      turn.timestamps.bargeInAtMs = this.timestamp();
    }
    return this.emit("barge_in", turn.turnId);
  }

  /**
   * Unlike the first-wins timestamp marks, every decision accumulates: holds
   * bump the per-turn count and both outcomes feed the worst-latency figure.
   */
  markEndpointDecision(
    turnId: string | undefined,
    decision: LiveVoiceEndpointDecisionMark,
  ): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (decision.action === "hold") {
      turn.endpointHoldCount += 1;
    }
    const latencyMs = Number.isFinite(decision.latencyMs)
      ? Math.max(0, decision.latencyMs)
      : 0;
    turn.endpointDecisionMaxLatencyMs = Math.max(
      turn.endpointDecisionMaxLatencyMs ?? 0,
      latencyMs,
    );
    return this.emit("endpoint_decision", turn.turnId);
  }

  markFirstAssistantDelta(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstAssistantDeltaAtMs === null) {
      turn.timestamps.firstAssistantDeltaAtMs = this.timestamp();
    }
    return this.emit("first_assistant_delta", turn.turnId);
  }

  markFirstTtsAudio(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstTtsAudioAtMs === null) {
      turn.timestamps.firstTtsAudioAtMs = this.timestamp();
    }
    return this.emit("first_tts_audio", turn.turnId);
  }

  /**
   * Record that a floor-holding spoken acknowledgement spoke this turn. Only
   * the first ack per turn is recorded (subsequent calls are no-ops), so the
   * field reflects "did an ack cover the wait", not a running count.
   */
  markSpokenAck(
    kind: LiveVoiceSpokenAckKind,
    turnId?: string,
  ): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.ackSpoken === null) {
      turn.ackSpoken = kind;
    }
    return this.emit("ack_spoken", turn.turnId);
  }

  completeTurn(turnId?: string): LiveVoiceTurnMetrics {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.status === "active") {
      turn.status = "completed";
      turn.timestamps.completedAtMs = this.timestamp();
      this.finishTurn(turn);
    }
    this.emit("turn_completed", turn.turnId);
    return snapshotTurn(turn);
  }

  cancelTurn(reason = "cancelled", turnId?: string): LiveVoiceTurnMetrics {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.status === "active") {
      turn.status = "cancelled";
      turn.cancellationReason = reason;
      turn.timestamps.cancelledAtMs = this.timestamp();
      this.finishTurn(turn);
    }
    this.emit("turn_cancelled", turn.turnId);
    return snapshotTurn(turn);
  }

  getSnapshot(): LiveVoiceMetricsSnapshot {
    return {
      session: this.getSessionMetrics(),
      activeTurn: this.activeTurn ? snapshotTurn(this.activeTurn) : null,
      recentTurns: this.recentTurns.map(snapshotTurn),
      summary: summarizeTurns(this.recentTurns),
    };
  }

  private getSessionMetrics(): LiveVoiceSessionMetrics {
    return {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      startedAtMs: this.sessionStartedAtMs,
      readyAtMs: this.readyAtMs,
      startToReadyMs: duration(this.sessionStartedAtMs, this.readyAtMs),
    };
  }

  private ensureActiveTurn(turnId?: string): MutableTurn {
    if (this.activeTurn === null) {
      return this.mutableStartTurn(turnId ?? this.createTurnId());
    }

    if (turnId !== undefined && this.activeTurn.turnId !== turnId) {
      this.cancelTurn("superseded");
      return this.mutableStartTurn(turnId);
    }

    return this.activeTurn;
  }

  private mutableStartTurn(turnId: string): MutableTurn {
    this.startTurn(turnId);
    if (this.activeTurn === null) {
      throw new Error("Live voice metrics failed to start a turn.");
    }
    return this.activeTurn;
  }

  private finishTurn(turn: MutableTurn): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }

    this.recentTurns.push(cloneMutableTurn(turn));
    while (this.recentTurns.length > this.recentTurnLimit) {
      this.recentTurns.shift();
    }
  }

  private timestamp(): number {
    const raw = this.clock();
    if (!Number.isFinite(raw)) {
      throw new Error(
        `Live voice metrics clock returned a non-finite value: ${raw}`,
      );
    }

    const normalized = Math.max(this.lastTimestampMs, raw);
    this.lastTimestampMs = normalized;
    return normalized;
  }

  private emit(
    event: LiveVoiceMetricsEvent,
    turnId?: string,
  ): LiveVoiceMetricsFrame {
    const frame: LiveVoiceMetricsFrame = {
      type: "metrics",
      event,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      turnId,
      metrics: this.getSnapshot(),
    };
    this.emitFrame?.(frame);
    return frame;
  }

  private createTurnId(): string {
    const turnId = `turn-${this.nextTurnNumber}`;
    this.nextTurnNumber += 1;
    return turnId;
  }
}

export function getLiveVoiceMetricsAggregateFields(
  snapshot: LiveVoiceMetricsSnapshot,
  turnId?: string,
): LiveVoiceMetricsAggregateFields {
  const turn = selectTurnForAggregate(snapshot, turnId);
  if (!turn) {
    return {
      sttMs: null,
      llmFirstDeltaMs: null,
      dispatchToFirstDeltaMs: null,
      dispatchToFirstAudioMs: null,
      ttsFirstAudioMs: null,
      totalMs: null,
    };
  }

  return {
    sttMs: turn.durations.pttReleaseToFinalTranscriptMs,
    llmFirstDeltaMs: turn.durations.finalTranscriptToFirstAssistantDeltaMs,
    dispatchToFirstDeltaMs: turn.durations.dispatchToFirstAssistantDeltaMs,
    dispatchToFirstAudioMs: turn.durations.dispatchToFirstTtsAudioMs,
    ttsFirstAudioMs: turn.durations.firstAssistantDeltaToFirstTtsAudioMs,
    totalMs: turn.durations.totalTurnDurationMs,
    ...endpointFields(turn),
  };
}

/**
 * Shared optional front-door fields for turn snapshots and aggregate frame
 * fields: absent unless an endpoint decision was recorded, so turns that
 * never touch the front door are byte-identical to before.
 */
function endpointFields(turn: {
  endpointHoldCount?: number | null;
  endpointDecisionMaxLatencyMs?: number | null;
}): Pick<
  LiveVoiceTurnMetrics,
  "endpointHoldCount" | "endpointDecisionMaxLatencyMs"
> {
  return turn.endpointDecisionMaxLatencyMs != null
    ? {
        endpointHoldCount: turn.endpointHoldCount ?? 0,
        endpointDecisionMaxLatencyMs: turn.endpointDecisionMaxLatencyMs,
      }
    : {};
}

function normalizeRecentTurnLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECENT_TURN_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_RECENT_TURN_LIMIT;
  return Math.floor(limit);
}

function selectTurnForAggregate(
  snapshot: LiveVoiceMetricsSnapshot,
  turnId: string | undefined,
): LiveVoiceTurnMetrics | null {
  if (turnId !== undefined) {
    if (snapshot.activeTurn?.turnId === turnId) return snapshot.activeTurn;
    const matchingRecentTurn = snapshot.recentTurns.find(
      (turn) => turn.turnId === turnId,
    );
    if (matchingRecentTurn) return matchingRecentTurn;
  }

  return (
    snapshot.activeTurn ??
    snapshot.recentTurns[snapshot.recentTurns.length - 1] ??
    null
  );
}

function cloneMutableTurn(turn: MutableTurn): MutableTurn {
  return {
    turnId: turn.turnId,
    status: turn.status,
    cancellationReason: turn.cancellationReason,
    ackSpoken: turn.ackSpoken,
    timestamps: { ...turn.timestamps },
    endpointHoldCount: turn.endpointHoldCount,
    endpointDecisionMaxLatencyMs: turn.endpointDecisionMaxLatencyMs,
  };
}

function snapshotTurn(turn: MutableTurn): LiveVoiceTurnMetrics {
  const timestamps = { ...turn.timestamps };
  return {
    turnId: turn.turnId,
    status: turn.status,
    cancellationReason: turn.cancellationReason,
    ackSpoken: turn.ackSpoken,
    timestamps,
    durations: {
      firstAudioToFirstPartialMs: duration(
        timestamps.firstAudioAtMs,
        timestamps.firstPartialAtMs,
      ),
      pttReleaseToFinalTranscriptMs: duration(
        timestamps.pttReleaseAtMs,
        timestamps.finalTranscriptAtMs,
      ),
      finalTranscriptToFirstAssistantDeltaMs: duration(
        timestamps.finalTranscriptAtMs,
        timestamps.firstAssistantDeltaAtMs,
      ),
      dispatchToFirstAssistantDeltaMs: duration(
        timestamps.assistantDispatchAtMs,
        timestamps.firstAssistantDeltaAtMs,
      ),
      dispatchToFirstTtsAudioMs: duration(
        timestamps.assistantDispatchAtMs,
        timestamps.firstTtsAudioAtMs,
      ),
      firstAssistantDeltaToFirstTtsAudioMs: duration(
        timestamps.firstAssistantDeltaAtMs,
        timestamps.firstTtsAudioAtMs,
      ),
      totalTurnDurationMs: duration(
        timestamps.startedAtMs,
        timestamps.completedAtMs ?? timestamps.cancelledAtMs,
      ),
    },
    ...endpointFields(turn),
  };
}

function summarizeTurns(turns: MutableTurn[]): LiveVoiceMetricsSummary {
  const snapshots = turns.map(snapshotTurn);
  const durations = snapshots.map((turn) => turn.durations);

  return {
    retainedTurnCount: snapshots.length,
    completedTurnCount: snapshots.filter((turn) => turn.status === "completed")
      .length,
    cancelledTurnCount: snapshots.filter((turn) => turn.status === "cancelled")
      .length,
    durations: {
      firstAudioToFirstPartialMs: summarizeDuration(
        durations.map((value) => value.firstAudioToFirstPartialMs),
      ),
      pttReleaseToFinalTranscriptMs: summarizeDuration(
        durations.map((value) => value.pttReleaseToFinalTranscriptMs),
      ),
      finalTranscriptToFirstAssistantDeltaMs: summarizeDuration(
        durations.map((value) => value.finalTranscriptToFirstAssistantDeltaMs),
      ),
      firstAssistantDeltaToFirstTtsAudioMs: summarizeDuration(
        durations.map((value) => value.firstAssistantDeltaToFirstTtsAudioMs),
      ),
      totalTurnDurationMs: summarizeDuration(
        durations.map((value) => value.totalTurnDurationMs),
      ),
    },
  };
}

function summarizeDuration(
  values: Array<number | null>,
): LiveVoiceDurationSummary {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(
  sortedValues: number[],
  percentileValue: number,
): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)];
}

function duration(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null) return null;
  return Math.max(0, endMs - startMs);
}
