/**
 * Cue Live — off-desktop explainer (design frame L1).
 *
 * The bug this fixes: on the web, Intelligence › Cue Live rendered a bare
 * remote viewer. A user with no Mac session saw a dead panel, pressed run, and
 * nothing happened — no statement of where control lives, no turn-on path, no
 * download. Web is a *remote*, never a gate: it can't hold Screen Recording or
 * Accessibility, so it explains, points at the Mac, and becomes the viewer the
 * moment a session is live.
 *
 * Honest by construction:
 *  - the summon accelerator is the live/shipped value, never a literal;
 *  - the four Mac states (never paired / paired-offline / connected-idle /
 *    live) are derived from `organizer/session` + `cuelive/session`;
 *  - there is no browser→app deep link yet, so we say "open Cue on your Mac"
 *    instead of rendering a button that does nothing.
 */
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { CueLiveRemoteViewer } from "@/domains/intelligence/cue-live-remote-viewer";
import {
  Keycap,
  hotkeyGlyphs,
  useCueLiveHotkey,
} from "@/domains/intelligence/cue-live-hotkey";
import {
  deriveCueLiveWebState,
  relativeSince,
  type CueLiveWebState,
} from "@/domains/intelligence/cue-live-web-state";
import {
  cueliveSessionGetOptions,
  organizerSessionGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  MACOS_DOWNLOAD_URL,
  writeMacOsAppDownloaded,
} from "@/hooks/use-macos-app-nudge";
import { C, mono } from "@/lib/hq-theme";

const POLL_MS = 10_000;

const card: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  padding: "16px 18px",
};

const microLabel: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase",
  color: C.t3,
};

/* -------------------------------------------------------------------------- */
/* Header — states the truth before anything else                             */
/* -------------------------------------------------------------------------- */

function RemotePill() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: C.blueW,
        border: `1px solid color-mix(in srgb, var(--mv1-blue) 32%, transparent)`,
        color: C.blueS,
        padding: "6px 12px",
        borderRadius: 999,
        fontFamily: mono,
        fontSize: 11,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: C.blue,
        }}
      />
      This is the remote — control runs on your Mac
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* What it does on the Mac — the three modes, in plain words                   */
/* -------------------------------------------------------------------------- */

const MODES = [
  {
    glyph: "👁",
    name: "Look",
    body: "Reads what's on screen to answer & summarize — no control.",
  },
  {
    glyph: "🧭",
    name: "Guide",
    body: "Points at what to click; you stay in the driver's seat.",
  },
  {
    glyph: "✦",
    name: "Take control",
    body: "Does the clicks itself — shows each move first, asks before anything irreversible.",
  },
] as const;

function ModesCard() {
  return (
    <div style={card}>
      <div style={microLabel}>What it does on the Mac</div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          marginTop: 13,
        }}
      >
        {MODES.map((m) => (
          <div key={m.name} style={{ display: "flex", gap: 11 }}>
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: C.sunken,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                flexShrink: 0,
              }}
            >
              {m.glyph}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: C.t1 }}>
                {m.name}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: C.t2,
                  marginTop: 2,
                  lineHeight: 1.45,
                }}
              >
                {m.body}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Turn it on — the numbered rail                                             */
/* -------------------------------------------------------------------------- */

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: 20,
        height: 20,
        borderRadius: "50%",
        background: C.blue,
        color: "#fff",
        fontFamily: mono,
        fontSize: 10.5,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        marginTop: 1,
      }}
    >
      {n}
    </span>
  );
}

function TurnOnRail({ hotkey }: { hotkey: string }) {
  const steps: React.ReactNode[] = [
    <>
      Open the <strong>Cue desktop app</strong> on your Mac
    </>,
    <>
      Grant <strong>Screen Recording</strong> + <strong>Accessibility</strong>{" "}
      once
    </>,
    <>
      Press <Keycap>{hotkeyGlyphs(hotkey)}</Keycap> to summon Cue on any screen
    </>,
  ];
  return (
    <div style={card}>
      <div style={microLabel}>Turn it on</div>
      <ol
        style={{
          listStyle: "none",
          margin: "13px 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {steps.map((step, i) => (
          <li
            // Static copy in a fixed order — the index IS the identity.
            key={i}
            style={{
              display: "flex",
              gap: 10,
              fontSize: 13,
              color: C.t2,
              lineHeight: 1.5,
              alignItems: "flex-start",
            }}
          >
            <StepNumber n={i + 1} />
            <span style={{ minWidth: 0 }}>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Session stub — the honest "where is your Mac" panel                        */
/* -------------------------------------------------------------------------- */

function StateDot({ tone }: { tone: "idle" | "amber" | "grey" }) {
  const color = tone === "idle" ? C.blue : tone === "amber" ? C.amber : C.t3;
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        // Blue = running/reachable; it breathes. Amber + grey stay still.
        animation: tone === "idle" ? "cueBlink 1.8s infinite" : undefined,
      }}
    />
  );
}

/** Copy per state — the point of the whole frame. */
function sessionCopy(state: CueLiveWebState): {
  tone: "idle" | "amber" | "grey";
  title: string;
  body: string;
  meta?: string;
} {
  switch (state.kind) {
    case "loading":
      return {
        tone: "grey",
        title: "Checking your Mac…",
        body: "Looking for a Cue desktop app signed in to this workspace.",
      };
    case "unreachable":
      return {
        tone: "amber",
        title: "Can't reach your Cue instance",
        body: "The steps on the left still apply — Cue Live turns on from the Mac app either way.",
      };
    case "unpaired":
      return {
        tone: "grey",
        title: "No Mac session right now",
        body: "No Cue desktop app has checked in on this workspace yet. Install it on your Mac and this panel becomes a live viewer — you'll see the screen activity and every move here.",
      };
    case "offline":
      return {
        tone: "amber",
        title: `${state.machineName ?? "Your Mac"} — not connected`,
        body: "Cue knows this Mac but it isn't connected right now. Open Cue on that Mac to bring it back; waking it from the browser isn't wired yet.",
        meta: relativeSince(state.lastSeenAt)
          ? `last seen ${relativeSince(state.lastSeenAt)}`
          : undefined,
      };
    case "idle":
      return {
        tone: "idle",
        title: `${state.machineName ?? "Your Mac"} — connected, idle`,
        body: "The Mac app is here. Summon Cue Live on that Mac and this panel turns into the live viewer.",
      };
    case "live":
      // Handled by the remote viewer, never rendered here.
      return { tone: "idle", title: "Live", body: "" };
  }
}

function SessionStub({
  state,
  hotkey,
}: {
  state: CueLiveWebState;
  hotkey: string;
}) {
  const copy = sessionCopy(state);
  return (
    <div
      style={{
        ...card,
        background: C.sunken,
        borderStyle: state.kind === "idle" ? "solid" : "dashed",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <StateDot tone={copy.tone} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: C.t1 }}>
          {copy.title}
        </span>
        {copy.meta ? (
          <span
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              color: C.t3,
              marginLeft: "auto",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {copy.meta}
          </span>
        ) : null}
      </div>
      <div
        style={{ fontSize: 12.5, color: C.t2, marginTop: 8, lineHeight: 1.5 }}
      >
        {copy.body}
      </div>
      {state.kind === "idle" ? (
        <div
          style={{
            fontSize: 12.5,
            color: C.t2,
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexWrap: "wrap",
          }}
        >
          <Keycap>{hotkeyGlyphs(hotkey)}</Keycap>
          <span>on that Mac summons it.</span>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

function GetTheApp({ paired }: { paired: boolean }) {
  return (
    <div style={card}>
      <div style={microLabel}>{paired ? "Bring it back" : "Get the app"}</div>
      {paired ? (
        <div
          style={{
            fontSize: 13,
            color: C.t2,
            marginTop: 11,
            lineHeight: 1.5,
          }}
        >
          Open <strong>Cue</strong> from your Mac's menu bar or Applications
          folder. There's no browser&nbsp;→&nbsp;app handoff yet, so this page
          can't launch it for you — it will pick the session up on its own once
          Cue is running.
        </div>
      ) : null}
      <a
        href={MACOS_DOWNLOAD_URL}
        target="_blank"
        rel="noreferrer"
        onClick={() => writeMacOsAppDownloaded()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          marginTop: 12,
          borderRadius: 9,
          background: paired ? "transparent" : C.blue,
          border: paired ? `1px solid ${C.line2}` : "1px solid transparent",
          color: paired ? C.t1 : "#fff",
          padding: "9px 15px",
          fontSize: 13,
          fontWeight: 500,
          textDecoration: "none",
        }}
      >
        {paired ? "Download again ↗" : "Download for Mac ↗"}
      </a>
      {!paired ? (
        <div
          style={{
            fontSize: 11.5,
            color: C.t3,
            marginTop: 9,
            lineHeight: 1.5,
          }}
        >
          Already installed? Open Cue on that Mac and sign in to this workspace
          — it shows up here within a few seconds.
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The frame                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The frame itself, with no data layer — so every state can be rendered in the
 * design preview and in tests without a daemon.
 */
export function CueLiveExplainerView({
  state,
  hotkey,
  isMobile = false,
}: {
  state: Exclude<CueLiveWebState, { kind: "live" }>;
  hotkey: string;
  isMobile?: boolean;
}) {
  const paired = state.kind === "offline" || state.kind === "idle";

  return (
    <div
      data-slot="cue-live-explainer"
      style={{
        maxWidth: 1000,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <RemotePill />
        <div>
          <div
            style={{
              fontSize: isMobile ? 22 : 26,
              fontWeight: 500,
              letterSpacing: "-.5px",
              color: C.t1,
            }}
          >
            Cue Live runs on your Mac
          </div>
          <div
            style={{
              fontSize: 13.5,
              color: C.t2,
              marginTop: 5,
              lineHeight: 1.55,
              maxWidth: 560,
            }}
          >
            It sees and acts on your actual screen. Open the Cue desktop app to
            turn it on — this page is your remote to watch and steer.
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) 340px",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <ModesCard />
          <TurnOnRail hotkey={hotkey} />
        </div>
        <aside style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <SessionStub state={state} hotkey={hotkey} />
          <GetTheApp paired={paired} />
        </aside>
      </div>

      <div
        style={{
          fontSize: 11.5,
          color: C.t3,
          lineHeight: 1.55,
          borderTop: `1px solid ${C.line}`,
          paddingTop: 12,
        }}
      >
        The web can't hold Screen Recording or Accessibility — macOS grants
        those to the app on the machine. So this page never asks you for them;
        it explains, and mirrors the Mac when a session is live.
      </div>
    </div>
  );
}

export function CueLiveWebExplainer() {
  const assistantId = useActiveAssistantId();
  const isMobile = useIsMobile();
  const hotkey = useCueLiveHotkey();

  const organizerQuery = useQuery({
    ...organizerSessionGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
    refetchInterval: POLL_MS,
  });
  const cueLiveQuery = useQuery({
    ...cueliveSessionGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    refetchInterval: POLL_MS,
  });

  const state = deriveCueLiveWebState({
    organizer: organizerQuery.data,
    cueLive: cueLiveQuery.data,
    isLoading: organizerQuery.isLoading || cueLiveQuery.isLoading,
    isError: organizerQuery.isError && cueLiveQuery.isError,
  });

  // A session is running — the same route becomes the remote viewer that
  // already ships. Nothing to explain; hand over.
  if (state.kind === "live") return <CueLiveRemoteViewer />;

  return (
    <CueLiveExplainerView state={state} hotkey={hotkey} isMobile={isMobile} />
  );
}
