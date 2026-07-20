/**
 * Cue Live remote viewer — frame 52 of the mobile-v3 spec.
 *
 * Off the Mac, Cue Live is not a dead end: this screen is a live remote of
 * the session running on the desktop. It shows only what the daemon
 * genuinely knows — the guidance/look/act stream the Mac sends while a
 * session runs (metadata, never frames) — and offers the two controls the
 * daemon can honestly provide: Pause (hold Cue's answers) and Stop (end the
 * auto-run in flight). Capture itself stays macOS-only, and the screen says
 * so.
 *
 * The frame's watched-screen minimap slot renders as a live status tile:
 * the daemon never retains screenshots, so there is no image to show — the
 * tile reports the real watching metadata (frontmost app, screen size, last
 * seen) instead of faking a thumbnail.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { cueliveSessionGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  cueliveSessionPausePost,
  cueliveSessionStopPost,
} from "@/generated/daemon/sdk.gen";
import type { CueliveSessionGetResponse } from "@/generated/daemon/types.gen";

/* v3 mobile grammar tokens (docs/design/mobile-v3, frame 52). */
const V3 = {
  bg: "#0A0C12",
  glass: "rgba(28,32,44,.72)",
  hairline: "rgba(255,255,255,.10)",
  t1: "#F4F4F6",
  t2: "#9A9AA8",
  t3: "#5B5B68",
  green: "#6FD69A",
  blue: "#3D6EE8",
  blueSoft: "#7FA3F2",
  red: "#E5675B",
  amber: "#E8C268",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

const POLL_MS = 7_000;

type SessionView = CueliveSessionGetResponse;
type Observation = SessionView["observations"][number];

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
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? "<1 min" : `${m} min`;
}

/** Green live dot with the v3Ping halo (still grey dot when not live). */
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

/**
 * The frame's minimap slot, degraded honestly: the daemon holds no frames,
 * so this is a status tile over the real watching metadata.
 */
function WatchedScreenTile({ session }: { session: SessionView }) {
  const watching = session.watching;
  const seen = relativeTime(watching?.at ?? session.lastSeenAt);
  return (
    <div
      style={{
        background: "rgba(255,255,255,.05)",
        border: `1px solid ${V3.hairline}`,
        borderRadius: 11,
        marginTop: 11,
        padding: "12px 13px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {watching?.appName ? (
          <span
            style={{
              fontFamily: V3.mono,
              fontSize: 10,
              color: V3.blueSoft,
              background: "rgba(61,110,232,.14)",
              padding: "2px 7px",
              borderRadius: 4,
            }}
          >
            watching: {watching.appName}
          </span>
        ) : (
          <span style={{ fontFamily: V3.mono, fontSize: 10, color: V3.t2 }}>
            watching your Mac
          </span>
        )}
        <span
          style={{
            fontFamily: V3.mono,
            fontSize: 10,
            color: V3.t3,
            marginLeft: "auto",
          }}
        >
          {watching?.screen
            ? `${watching.screen.width}×${watching.screen.height}`
            : ""}
          {seen ? `${watching?.screen ? " · " : ""}${seen}` : ""}
        </span>
      </div>
      <div style={{ fontSize: 10.5, color: V3.t3, lineHeight: 1.45 }}>
        No frames leave your Mac — Cue reports what it's doing, not pixels.
      </div>
    </div>
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
      </span>
    </div>
  );
}

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

function ActiveState({
  session,
  assistantId,
}: {
  session: SessionView;
  assistantId: string;
}) {
  const queryClient = useQueryClient();
  const [stopNote, setStopNote] = useState<string | null>(null);
  const sessionKey = cueliveSessionGetOptions({
    path: { assistant_id: assistantId },
  }).queryKey;

  const pause = useMutation({
    mutationFn: async (paused: boolean) => {
      const { data } = await cueliveSessionPausePost({
        path: { assistant_id: assistantId },
        body: { paused },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(sessionKey, data);
    },
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
      setStopNote(data.note);
      queryClient.setQueryData(sessionKey, data.session);
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
      {/* Live header */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <PulseDot color={paused ? V3.amber : V3.green} still={paused} />
        <span
          style={{ fontSize: 13.5, fontWeight: 600, flex: 1, color: V3.t1 }}
        >
          {paused ? "Paused from your phone" : "Live on your Mac"}
        </span>
        {duration && (
          <span style={{ fontFamily: V3.mono, fontSize: 10, color: V3.t2 }}>
            {duration}
          </span>
        )}
      </div>

      <WatchedScreenTile session={session} />

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
              fontFamily: V3.mono,
              fontSize: 10,
              color: V3.blueSoft,
              background: "rgba(61,110,232,.14)",
              padding: "2px 7px",
              borderRadius: 4,
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

      {/* Controls — the two remote controls the daemon really has. */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
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
          {paused ? "▶ Resume watching" : "⏸ Pause watching"}
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
          ■ Stop run
        </button>
      </div>
      {(stopNote || paused) && (
        <div
          style={{
            fontSize: 10.5,
            color: V3.t3,
            marginTop: 8,
            lineHeight: 1.45,
          }}
        >
          {stopNote ??
            "Cue is holding its answers — the Mac overlay falls back to local hints until you resume."}
        </div>
      )}
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
    // so the remote stops asking when the app is backgrounded.
    refetchInterval: POLL_MS,
  });

  const session = data ?? null;

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
      {isError ? (
        <div
          style={{
            padding: "26px 18px",
            textAlign: "center",
            fontSize: 12,
            color: V3.t2,
            lineHeight: 1.5,
          }}
        >
          Can't reach the live view right now — your Cue instance may be
          offline or need an update.
        </div>
      ) : isLoading ? (
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
      <div
        style={{
          fontSize: 11,
          color: V3.t3,
          textAlign: "center",
          marginTop: 12,
          lineHeight: 1.5,
        }}
      >
        Capture runs on the Mac only. Your phone is the remote:
        <br />
        see, pause, or stop from anywhere.
      </div>
    </div>
  );
}
