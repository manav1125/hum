/**
 * Cue Live remote viewer — L2 of the discovery/clarity pack, and frame 52 of
 * the mobile-v3 spec.
 *
 * This screen is the remote for the Cue Live session running on the Mac. It
 * used to be metadata-only and said so on screen. It now shows the real
 * screen, so the copy on screen changed in the same breath as the capability:
 * where the frames go, who can see them, and how they stop is stated plainly
 * on the surface rather than in a policy page.
 *
 * Three things hold this together:
 *
 * - **The stream is opt-in.** Opening this screen captures nothing. The owner
 *   presses Start screen, the Mac shows an on-screen notice while frames are
 *   leaving, and either device can stop. Closing this tab stops it too — the
 *   daemon disarms a stream nobody is reading.
 * - **Frames are ephemeral.** The daemon holds exactly one frame in memory and
 *   replaces it on the next push. Nothing is written to the database or disk.
 * - **Steering is not a back door.** Take over is explicit, expires, and every
 *   relayed click goes through the same host computer-use path the agent uses,
 *   under the same global trust dial. When the dial says Observe, this screen
 *   watches and nothing more — and says why.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  cueliveSessionFrameGetOptions,
  cueliveSessionGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  cueliveSessionInputPost,
  cueliveSessionPausePost,
  cueliveSessionStopPost,
  cueliveSessionStreamPost,
  cueliveSessionTakeoverPost,
} from "@/generated/daemon/sdk.gen";
import type {
  CueliveSessionGetResponse,
  CueliveSessionInputPostData,
} from "@/generated/daemon/types.gen";

/* v3 mobile grammar tokens (docs/design/mobile-v3, frame 52). */
const V3 = {
  bg: "#0A0C12",
  glass: "rgba(28,32,44,.72)",
  hairline: "rgba(255,255,255,.10)",
  t1: "#F4F4F6",
  t2: "#9A9AA8",
  // Muted text on a dark ground is #9A9AA8 and nothing dimmer. #5B5B68 sits at
  // ~2.5:1 here, which is unreadable, and it has now regressed into three
  // separate design packs — so t3 is deliberately the same value as t2 rather
  // than a dimmer one that would invite the mistake back.
  t3: "#9A9AA8",
  green: "#6FD69A",
  blue: "#3D6EE8",
  blueSoft: "#7FA3F2",
  red: "#E5675B",
  amber: "#E8C268",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/** Session/control poll. Frames poll on their own, faster, clock. */
const POLL_MS = 5_000;
/** Floor for the frame poll, so a fast daemon cadence can't spin the browser. */
const MIN_FRAME_POLL_MS = 500;

type SessionView = CueliveSessionGetResponse;
type Observation = SessionView["observations"][number];
type StreamStatus = SessionView["stream"];
type RelayKind = CueliveSessionInputPostData["body"] extends {
  kind: infer K;
}
  ? K
  : never;

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function sessionMinutes(iso: string | null): string | null {
  if (!iso) return null;
  const m = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  return m < 1 ? "<1 min" : `${m} min`;
}

/**
 * The device the session is running on, by name when the Mac told us and by
 * honest description when it didn't — never a literal placeholder.
 */
function deviceLabel(session: SessionView): string {
  return session.stream.mac?.deviceName ?? "your Mac";
}

/**
 * Running is a BLUE pulse. Green means done in this grammar, and a green
 * "live" dot read as "finished" every time somebody glanced at it.
 */
function PulseDot({ color, still }: { color: string; still?: boolean }) {
  return (
    <span
      style={{
        position: "relative",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        display: "inline-block",
      }}
    >
      {!still && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: color,
            animation: "cueV3Ping 1.8s ease-out infinite",
          }}
        />
      )}
    </span>
  );
}

const chip: React.CSSProperties = {
  fontFamily: V3.mono,
  fontSize: 10,
  padding: "2px 7px",
  borderRadius: 4,
};

/* -------------------------------------------------------------------------- */
/* The mirror                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The honest line under the mirror. It changes with the state because the
 * truth changes with the state: when nothing is streaming, nothing is
 * captured; when frames are flowing, they are flowing to the owner's own Cue
 * instance and nowhere else.
 */
function StreamDisclosure({
  stream,
  takeoverArmed,
}: {
  stream: StreamStatus;
  takeoverArmed: boolean;
}) {
  const live = stream.state === "live" || stream.state === "starting";
  return (
    <div style={{ fontSize: 10.5, color: V3.t3, lineHeight: 1.5, marginTop: 8 }}>
      {live ? (
        <>
          Your Mac is sending screen frames to <strong>your own Cue
          instance</strong> — no third party, no other client. Each frame is
          held in memory for this view and replaced by the next one; none are
          saved to disk or to your history. Stop here, stop on the Mac, or
          close this tab and it ends.
          {takeoverArmed
            ? " Take over is armed, so your clicks go to the Mac through the same approval path Cue itself uses."
            : ""}
        </>
      ) : (
        <>
          Nothing is being captured. Start screen and your Mac sends frames to{" "}
          <strong>your own Cue instance</strong> — only you, signed in here, can
          see them, and they are never saved. Until then this view shows what
          Cue is doing, not pixels.
        </>
      )}
    </div>
  );
}

interface MirrorProps {
  session: SessionView;
  frame: {
    dataBase64: string;
    mediaType: string;
    width: number;
    height: number;
  } | null;
  takeoverArmed: boolean;
  onRelay: (action: {
    kind: RelayKind;
    x?: number;
    y?: number;
    text?: string;
    key?: string;
  }) => void;
  relayBusy: boolean;
}

/** The mirrored screen, or an honest placeholder for why there isn't one. */
function Mirror({
  session,
  frame,
  takeoverArmed,
  onRelay,
  relayBusy,
}: MirrorProps) {
  const stream = session.stream;

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (!takeoverArmed || !frame || relayBusy) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Rendered box → frame pixels. The daemon maps frame pixels → screen
      // points against the geometry of the frame it actually served, so the
      // browser never has to know about the Mac's display scale.
      const x = ((e.clientX - rect.left) / rect.width) * frame.width;
      const y = ((e.clientY - rect.top) / rect.height) * frame.height;
      onRelay({ kind: "click", x: Math.round(x), y: Math.round(y) });
    },
    [takeoverArmed, frame, relayBusy, onRelay],
  );

  const placeholder = (message: string, tone: string = V3.t3) => (
    <div
      style={{
        aspectRatio: "16 / 10",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 18,
        fontSize: 11.5,
        lineHeight: 1.5,
        color: tone,
      }}
    >
      {message}
    </div>
  );

  return (
    <div
      style={{
        background: "rgba(255,255,255,.05)",
        border: `1px solid ${takeoverArmed ? "rgba(61,110,232,.55)" : V3.hairline}`,
        borderRadius: 11,
        marginTop: 11,
        padding: "11px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            ...chip,
            color: V3.blueSoft,
            background: "rgba(61,110,232,.14)",
          }}
        >
          {stream.mac?.deviceName ?? "watching your Mac"}
          {session.watching?.appName ? ` · ${session.watching.appName}` : ""}
        </span>
        <span
          style={{
            ...chip,
            marginLeft: "auto",
            color: V3.t3,
            padding: 0,
          }}
        >
          {session.watching?.screen
            ? `${session.watching.screen.width}×${session.watching.screen.height}`
            : ""}
          {stream.state === "live" ? " · streaming" : ""}
        </span>
      </div>

      <div
        style={{
          marginTop: 9,
          borderRadius: 8,
          overflow: "hidden",
          background: "#05070C",
          border: `1px solid ${V3.hairline}`,
        }}
      >
        {frame ? (
          <img
            src={`data:${frame.mediaType};base64,${frame.dataBase64}`}
            alt={`Live screen of ${deviceLabel(session)}`}
            onClick={handleClick}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              cursor: takeoverArmed ? "crosshair" : "default",
              opacity: relayBusy ? 0.75 : 1,
              transition: "opacity .15s ease",
            }}
          />
        ) : stream.state === "starting" ? (
          placeholder("Waiting for the first frame from your Mac…")
        ) : stream.state === "stalled" ? (
          placeholder(
            stream.mac
              ? "Your Mac stopped sending frames. It may be asleep, or Cue Live may have stopped."
              : "Your Mac hasn't checked in. Open Cue on the Mac and try again.",
            V3.amber,
          )
        ) : stream.mac && !stream.mac.screenRecordingGranted ? (
          placeholder(
            "Your Mac doesn't have Screen Recording permission, so it can't share its screen.",
            V3.amber,
          )
        ) : (
          placeholder("Screen off — press Start screen to see this Mac.")
        )}
      </div>

      <StreamDisclosure stream={stream} takeoverArmed={takeoverArmed} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Observation stream                                                         */
/* -------------------------------------------------------------------------- */

/** The overlay's verify beat: ✓ verified · ↻ retrying · ‖ stuck. */
function VerifyBeat({ verify }: { verify: Observation["verify"] }) {
  if (!verify) return null;
  const map = {
    verified: { glyph: "✓", color: V3.green, label: "verified" },
    retrying: { glyph: "↻", color: V3.amber, label: "retrying" },
    stuck: { glyph: "‖", color: V3.red, label: "stuck" },
  } as const;
  const it = map[verify];
  return (
    <span
      style={{ ...chip, color: it.color, background: "rgba(255,255,255,.05)" }}
      title={`Cue reported this step as ${it.label} on the Mac`}
    >
      {it.glyph} {it.label}
    </span>
  );
}

function ObservationRow({ ob }: { ob: Observation }) {
  const held = ob.status === "held";
  const active = ob.status === "active";
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        fontSize: 11.5,
        lineHeight: 1.45,
        color: active ? V3.t1 : V3.t2,
        alignItems: "flex-start",
      }}
    >
      {active ? (
        <span style={{ marginTop: 4 }}>
          {/* Running is blue — green would read as finished. */}
          <PulseDot color={V3.blue} />
        </span>
      ) : held ? (
        <span style={{ color: V3.amber, flexShrink: 0 }}>⏸</span>
      ) : (
        <span style={{ color: V3.green, flexShrink: 0 }}>✓</span>
      )}
      <span style={{ minWidth: 0 }}>
        {ob.summary}
        {ob.detail ? (
          <span style={{ color: active ? V3.t2 : V3.t3 }}> · {ob.detail}</span>
        ) : null}
        {ob.verify ? (
          <span style={{ marginLeft: 6 }}>
            <VerifyBeat verify={ob.verify} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

const buttonBase: React.CSSProperties = {
  flex: 1,
  borderRadius: 11,
  padding: 10,
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};

/** Calm offline frame: still ring, honest copy. */
function InactiveState({ session }: { session: SessionView | null }) {
  const last = relativeTime(session?.lastSeenAt);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        padding: "38px 20px",
        textAlign: "center",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: "2px solid rgba(255,255,255,.14)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <PulseDot color={V3.t3} still />
      </span>
      <div>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: V3.t1 }}>
          Cue Live isn't running
        </div>
        <div
          style={{ fontSize: 12, color: V3.t2, marginTop: 5, lineHeight: 1.5 }}
        >
          Start it on your Mac — this screen becomes the live view.
        </div>
        {last && (
          <div
            style={{
              fontFamily: V3.mono,
              fontSize: 10,
              color: V3.t3,
              marginTop: 8,
            }}
          >
            last live {last}
          </div>
        )}
      </div>
    </div>
  );
}

/** The typed-input rail, shown only while take over is armed. */
function TypeRail({
  onRelay,
  busy,
}: {
  onRelay: MirrorProps["onRelay"];
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onRelay({ kind: "type", text: trimmed });
    setText("");
  };
  const keyButton = (key: string, label: string) => (
    <button
      key={key}
      type="button"
      disabled={busy}
      onClick={() => onRelay({ kind: "key", key })}
      style={{
        ...chip,
        border: `1px solid ${V3.hairline}`,
        background: "rgba(255,255,255,.06)",
        color: V3.t2,
        cursor: "pointer",
        padding: "4px 8px",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", gap: 7 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type on the Mac…"
          style={{
            flex: 1,
            minWidth: 0,
            borderRadius: 9,
            border: `1px solid ${V3.hairline}`,
            background: "rgba(255,255,255,.05)",
            color: V3.t1,
            fontFamily: "inherit",
            fontSize: 12,
            padding: "8px 10px",
          }}
        />
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={send}
          style={{
            borderRadius: 9,
            border: "1px solid rgba(61,110,232,.4)",
            background: "rgba(61,110,232,.18)",
            color: V3.blueSoft,
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 600,
            padding: "8px 12px",
            cursor: "pointer",
            opacity: busy || !text.trim() ? 0.55 : 1,
          }}
        >
          Send
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {keyButton("enter", "⏎ enter")}
        {keyButton("tab", "⇥ tab")}
        {keyButton("escape", "esc")}
        {keyButton("backspace", "⌫")}
      </div>
    </div>
  );
}

function ActiveState({
  session,
  assistantId,
}: {
  session: SessionView;
  assistantId: string;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const sessionKey = cueliveSessionGetOptions({
    path: { assistant_id: assistantId },
  }).queryKey;

  const stream = session.stream;
  const streaming = stream.armed;
  const takeoverArmed = session.takeover.armed;
  const dialBlocks = session.trustDial === "observe";

  /* --- frame poll: its own, faster clock, driven by the daemon's cadence --- */
  const frameKey = cueliveSessionFrameGetOptions({
    path: { assistant_id: assistantId },
  }).queryKey;
  const frameQuery = useQuery({
    ...cueliveSessionFrameGetOptions({ path: { assistant_id: assistantId } }),
    enabled: streaming,
    refetchInterval: Math.max(MIN_FRAME_POLL_MS, stream.intervalMs || 900),
    gcTime: 0,
  });
  // When the stream stops, the picture must go with it. Disabling the query
  // would leave the last frame sitting in the cache and on screen, which is
  // precisely the "it says stopped but I can still see your desktop" failure
  // this feature cannot afford — so drop it explicitly as well.
  const frame = streaming ? (frameQuery.data?.frame ?? null) : null;
  useEffect(() => {
    if (!streaming) queryClient.removeQueries({ queryKey: frameKey });
    // frameKey is derived from assistantId and stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, assistantId]);

  const invalidateSession = (next?: SessionView) => {
    if (next) queryClient.setQueryData(sessionKey, next);
    else void queryClient.invalidateQueries({ queryKey: sessionKey });
  };

  const pause = useMutation({
    mutationFn: async (paused: boolean) => {
      const { data } = await cueliveSessionPausePost({
        path: { assistant_id: assistantId },
        body: { paused },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => invalidateSession(data),
  });

  const stop = useMutation({
    mutationFn: async () => {
      const { data } = await cueliveSessionStopPost({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => {
      setNote(data.note);
      invalidateSession(data.session);
    },
  });

  const setStream = useMutation({
    mutationFn: async (on: boolean) => {
      const { data } = await cueliveSessionStreamPost({
        path: { assistant_id: assistantId },
        body: { streaming: on, origin: "web" },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => {
      setNote(
        data.armed
          ? "Asking your Mac to share its screen — it shows a notice while frames are leaving."
          : (data.lastStopReason ?? "Screen stream stopped."),
      );
      invalidateSession();
    },
  });

  const setTakeover = useMutation({
    mutationFn: async (armed: boolean) => {
      const { data } = await cueliveSessionTakeoverPost({
        path: { assistant_id: assistantId },
        body: { armed },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => {
      setNote(
        data.refused ??
          (data.takeover.armed
            ? "You're steering. Click the screen above; every action still goes through Cue's approval path on the Mac."
            : "Take over released."),
      );
      invalidateSession();
    },
  });

  const relay = useMutation({
    mutationFn: async (action: Parameters<MirrorProps["onRelay"]>[0]) => {
      const { data } = await cueliveSessionInputPost({
        path: { assistant_id: assistantId },
        body: action as CueliveSessionInputPostData["body"],
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => {
      setNote(data.refused ?? data.detail);
      invalidateSession(data.session);
    },
  });

  const paused = session.paused;
  const duration = sessionMinutes(session.sessionStartedAt);
  const observations = session.observations.slice(0, 6);
  const goal = session.goal;

  return (
    <div
      style={{
        background: V3.glass,
        border: `1px solid ${V3.hairline}`,
        borderRadius: 20,
        padding: "14px 15px",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
      }}
    >
      {/* Live header — blue pulse means running. */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <PulseDot color={paused ? V3.amber : V3.blue} still={paused} />
        <span
          style={{ fontSize: 13.5, fontWeight: 600, flex: 1, color: V3.t1 }}
        >
          {paused
            ? `Paused · ${deviceLabel(session)}`
            : `Live on ${deviceLabel(session)}`}
        </span>
        {duration && (
          <span style={{ fontFamily: V3.mono, fontSize: 10, color: V3.t2 }}>
            {duration}
          </span>
        )}
      </div>

      <Mirror
        session={session}
        frame={frame}
        takeoverArmed={takeoverArmed}
        onRelay={(action) => relay.mutate(action)}
        relayBusy={relay.isPending}
      />

      {takeoverArmed && (
        <TypeRail
          onRelay={(action) => relay.mutate(action)}
          busy={relay.isPending}
        />
      )}

      {/* Auto-run goal in flight */}
      {goal && !goal.done && (
        <div
          style={{
            marginTop: 11,
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 11.5,
            color: V3.t1,
          }}
        >
          <span
            style={{
              ...chip,
              color: V3.blueSoft,
              background: "rgba(61,110,232,.14)",
              flexShrink: 0,
            }}
          >
            auto-run · step {goal.step}
          </span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {goal.text}
          </span>
        </div>
      )}

      {/* Extraction / observation stream */}
      {observations.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 11,
          }}
        >
          {observations.map((ob) => (
            <ObservationRow key={ob.id} ob={ob} />
          ))}
        </div>
      )}

      {/* Screen on/off — the opt-in, never implicit. */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          disabled={setStream.isPending}
          onClick={() => setStream.mutate(!streaming)}
          style={{
            ...buttonBase,
            background: streaming
              ? "rgba(255,255,255,.08)"
              : "rgba(61,110,232,.18)",
            color: streaming ? V3.t1 : V3.blueSoft,
            border: `1px solid ${
              streaming ? "rgba(255,255,255,.12)" : "rgba(61,110,232,.4)"
            }`,
            opacity: setStream.isPending ? 0.6 : 1,
          }}
        >
          {streaming ? "◻ Stop screen" : "▣ Start screen"}
        </button>
        <button
          type="button"
          disabled={setTakeover.isPending || dialBlocks}
          title={
            dialBlocks
              ? "Your trust dial is set to Observe — Cue can watch this Mac but not act on it."
              : undefined
          }
          onClick={() => setTakeover.mutate(!takeoverArmed)}
          style={{
            ...buttonBase,
            background: takeoverArmed
              ? "rgba(61,110,232,.22)"
              : "rgba(255,255,255,.08)",
            color: dialBlocks ? V3.t3 : takeoverArmed ? V3.blueSoft : V3.t1,
            border: `1px solid ${
              takeoverArmed ? "rgba(61,110,232,.45)" : "rgba(255,255,255,.12)"
            }`,
            cursor: dialBlocks ? "not-allowed" : "pointer",
            opacity: setTakeover.isPending || dialBlocks ? 0.55 : 1,
          }}
        >
          {takeoverArmed ? "⤺ Release" : "⇱ Take over"}
        </button>
      </div>

      {/* Pause / Stop — the locked overlay vocabulary (state 4). */}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          type="button"
          disabled={pause.isPending}
          onClick={() => pause.mutate(!paused)}
          style={{
            ...buttonBase,
            background: "rgba(255,255,255,.08)",
            color: V3.t1,
            border: "1px solid rgba(255,255,255,.12)",
            opacity: pause.isPending ? 0.6 : 1,
          }}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button
          type="button"
          disabled={stop.isPending}
          onClick={() => stop.mutate()}
          style={{
            ...buttonBase,
            background: "rgba(229,103,91,.15)",
            color: V3.red,
            border: "1px solid rgba(229,103,91,.35)",
            opacity: stop.isPending ? 0.6 : 1,
          }}
        >
          ■ Stop
        </button>
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: V3.t3,
          marginTop: 8,
          lineHeight: 1.45,
        }}
      >
        {note ??
          (dialBlocks
            ? "Trust dial: Observe — this view watches only. Raise the dial to steer from the web."
            : paused
              ? "Cue is holding its answers — the Mac overlay falls back to local hints until you resume."
              : "Stop ends the run at the next safe boundary and cuts the screen stream.")}
      </div>
    </div>
  );
}

export function CueLiveRemoteViewer() {
  const assistantId = useActiveAssistantId();
  const { data, isError, isLoading } = useQuery({
    ...cueliveSessionGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
    // Foreground-only poll: refetchIntervalInBackground stays false (default),
    // so the remote stops asking when the app is backgrounded — which also
    // lets the daemon's unwatched-stream timeout stop the camera.
    refetchInterval: POLL_MS,
  });

  const session = data ?? null;
  // A poll that fails once must not blank a working view — the Mac is probably
  // still there. Only a failure with nothing to show becomes the error frame;
  // otherwise the last good session stays up under a quiet reconnecting note.
  const showErrorFrame = isError && !session;

  return (
    <div
      style={{
        background: V3.bg,
        borderRadius: 20,
        padding: 15,
        color: V3.t1,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif",
      }}
    >
      <style>{`@keyframes cueV3Ping{0%{transform:scale(.8);opacity:.5}80%,100%{transform:scale(2);opacity:0}}`}</style>
      {showErrorFrame ? (
        <div
          style={{
            padding: "26px 18px",
            textAlign: "center",
            fontSize: 12,
            color: V3.t2,
            lineHeight: 1.5,
          }}
        >
          Can't reach the live view right now — your Cue instance may be offline
          or need an update.
        </div>
      ) : isLoading && !session ? (
        <div
          style={{
            padding: "26px 18px",
            textAlign: "center",
            fontFamily: V3.mono,
            fontSize: 10,
            color: V3.t3,
          }}
        >
          checking your Mac…
        </div>
      ) : session?.active ? (
        <ActiveState session={session} assistantId={assistantId!} />
      ) : (
        <InactiveState session={session} />
      )}
      {isError && session && (
        <div
          style={{
            fontFamily: V3.mono,
            fontSize: 10,
            color: V3.amber,
            textAlign: "center",
            marginTop: 9,
          }}
        >
          reconnecting — showing the last state your Mac reported
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          color: V3.t3,
          textAlign: "center",
          marginTop: 12,
          lineHeight: 1.5,
        }}
      >
        Capture and control run on the Mac. This is the remote:
        <br />
        watch, steer, pause, or stop from anywhere.
      </div>
    </div>
  );
}
