/**
 * Cue Live — the single, honest "what is this and how do I use it" surface.
 *
 * This page used to be a ~1,800-line control panel (mode grid, voice bindings,
 * auto-run goal CRUD, a second voice-setup pane, a goal runner, a marketing
 * "how it sees" card…). It showed a hundred controls and never plainly answered
 * the only questions a user has:
 *   1. What is Cue Live?                → Cue can see your screen, and act on it.
 *   2. How do I turn it on?             → Mac app + two macOS grants + ⌃⌥Space.
 *   3. What can it actually do today?   → a short, TRUE list (no aspiration).
 *   4. Why does the overlay appear?     → because Cue is reading/acting/streaming.
 *   5. What should I use it for?        → concrete, grounded use cases.
 *
 * So it is cut to exactly those answers, wired to the same real state as before
 * (bridge status, live macOS grants, take-control toggle, summon / typed goal).
 *
 * Honesty rules kept intact:
 *  - Off the desktop app the web can never hold Screen Recording / Accessibility,
 *    so it explains and points at the Mac (delegated to {@link CueLiveWebExplainer},
 *    which becomes the live remote viewer the moment a session runs).
 *  - On the desktop app, capabilities that have no native backing are NOT shown as
 *    if they work; the permissions banner blocks when a grant is missing; the
 *    take-control switch reports plainly when a grant means it physically can't act.
 *
 * The REAL trigger, for the copy below: the only intentional summon is the global
 * hotkey Control+Option+Space (plus ⌥P point / ⌥R talk, all bound by the helper).
 * There is no chat keyword. The overlay "appearing on its own" is the helper
 * drawing a card/ring whenever Cue is looking at, acting on, or streaming the
 * screen — never a background watcher.
 */
import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  CueLivePermissions,
  CueLiveSettingsPane,
  CueLiveStatus,
} from "@vellumai/ipc-contract";

import { CueLiveWebExplainer } from "@/domains/intelligence/cue-live-explainer";
import { hotkeyGlyphs } from "@/domains/intelligence/cue-live-hotkey";
import { C, mono, serif } from "@/lib/hq-theme";
import { routes } from "@/utils/routes";
import {
  getCueLivePermissions,
  getCueLiveStatus,
  isCueLiveAvailable,
  isCueLivePermissionsSupported,
  isRunGoalSupported,
  openCueLiveSystemSettings,
  runGoal,
  setCueLiveEnabled,
  setCueLiveTakeControl,
  stopCueLive,
  summonCueLive,
} from "@/runtime/cue-live";

/* -------------------------------------------------------------------------- */
/* Small shared primitives (serif-HQ tokens, theme-aware)                      */
/* -------------------------------------------------------------------------- */

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
  marginBottom: 12,
};

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 11,
        background: C.sunken,
        border: `1px solid ${C.line2}`,
        color: C.t1,
        borderRadius: 6,
        padding: "3px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** A real, interactive switch (accent knob when on). */
function Toggle({
  on,
  busy,
  onChange,
  label,
}: {
  on: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        background: on ? C.blue : C.line2,
        position: "relative",
        flexShrink: 0,
        border: "none",
        padding: 0,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.5 : 1,
        transition: "background .15s ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          top: 2,
          left: on ? 18 : 2,
          transition: "left .15s ease",
          boxShadow: "0 1px 2px rgba(0,0,0,.18)",
        }}
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Permissions onboarding — the single most important "it doesn't work" fix.   */
/*                                                                             */
/* Kept (and still exported — the design-preview gallery renders it): Cue Live */
/* can neither see nor act without two macOS grants. Read non-prompting from   */
/* the helper; when either is missing we show a blocking banner that deep-links */
/* to the exact System Settings pane, one un-granted step lit at a time.       */
/* -------------------------------------------------------------------------- */

function PermissionRow({
  stage,
  title,
  detail,
  pane,
}: {
  stage: "granted" | "next" | "later";
  title: string;
  detail: string;
  pane: CueLiveSettingsPane;
}) {
  const granted = stage === "granted";
  const next = stage === "next";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 0",
        opacity: stage === "later" ? 0.45 : 1,
      }}
    >
      <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            marginTop: 1,
            width: 18,
            height: 18,
            flexShrink: 0,
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: granted ? C.green : next ? C.amber : "transparent",
            border: granted || next ? "none" : `1px solid ${C.line2}`,
            color: granted || next ? "#fff" : C.t3,
            fontSize: 10,
          }}
        >
          {granted ? "✓" : next ? "→" : ""}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: C.t1 }}>
            {title}
          </div>
          <div
            style={{ fontSize: 12, color: C.t2, marginTop: 2, lineHeight: 1.45 }}
          >
            {detail}
          </div>
        </div>
      </div>
      {granted ? (
        <span
          style={{ flexShrink: 0, fontFamily: mono, fontSize: 11, color: C.green }}
        >
          Granted
        </span>
      ) : next ? (
        <button
          type="button"
          onClick={() => void openCueLiveSystemSettings(pane)}
          style={{
            flexShrink: 0,
            borderRadius: 8,
            background: C.blue,
            color: "#fff",
            border: "none",
            padding: "8px 16px",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Grant
        </button>
      ) : null}
    </div>
  );
}

/**
 * The Mac grant flow — grant-then-it-works, one step at a time. Screen Recording
 * leads (it is what "Cue can't see anything" means); Accessibility follows (the
 * clicking + the summon hotkey). Disappears entirely once both are held.
 */
export function PermissionsBanner({
  permissions,
}: {
  permissions: CueLivePermissions;
}) {
  const screen = permissions.screenRecordingGranted;
  const access = permissions.accessibilityTrusted;
  if (screen && access) return null;

  const screenStage = screen ? "granted" : "next";
  const accessStage = access ? "granted" : screen ? "next" : "later";

  return (
    <div
      style={{
        borderRadius: 14,
        border: `1px solid color-mix(in srgb, var(--mv1-amber) 45%, transparent)`,
        background: `color-mix(in srgb, var(--mv1-amber) 9%, var(--mv1-card))`,
        padding: "16px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <ShieldAlert className="size-5" style={{ color: C.amber }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>
          Let Cue see &amp; act on your screen
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: C.t2, marginTop: 6, lineHeight: 1.5 }}>
        Two macOS permissions, granted once. Cue only looks when you summon it —
        nothing runs in the background. Until then, summon and &ldquo;Do it&rdquo;
        do nothing.
      </div>
      <div
        style={{
          marginTop: 10,
          borderTop: `1px solid color-mix(in srgb, var(--mv1-amber) 30%, transparent)`,
        }}
      >
        <PermissionRow
          stage={screenStage}
          title="Screen Recording"
          detail="so Cue can see the screen — the vision pass behind Look / Do it."
          pane="screenRecording"
        />
        <div
          style={{
            borderTop: `1px solid color-mix(in srgb, var(--mv1-amber) 30%, transparent)`,
          }}
        />
        <PermissionRow
          stage={accessStage}
          title="Accessibility"
          detail="so Cue can click & type for you — and so the summon hotkey is armed."
          pane="accessibility"
        />
      </div>
      <div style={{ fontSize: 11.5, color: C.t3, marginTop: 10, lineHeight: 1.5 }}>
        Opens System Settings → Privacy &amp; Security. Cue can&rsquo;t grant
        these for you — macOS asks you directly. This page updates on its own
        once you do.
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. What it is + status pill (the enable control)                            */
/* -------------------------------------------------------------------------- */

function StatusPill({
  status,
  busy,
  onToggle,
}: {
  status: CueLiveStatus;
  busy: boolean;
  onToggle: () => void;
}) {
  const on = status.enabled;
  const label = !on
    ? "off"
    : status.streamingScreen
      ? "streaming your screen"
      : status.running
        ? "on · watching for your summon"
        : "on";
  return (
    <button
      type="button"
      data-coach="cuelive-enable"
      disabled={busy}
      onClick={onToggle}
      title={on ? "Turn Cue Live off" : "Turn Cue Live on"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: on ? C.blueW : C.sunken,
        border: `1px solid ${on ? "color-mix(in srgb, var(--mv1-blue) 40%, transparent)" : C.line2}`,
        color: on ? C.blueS : C.t3,
        padding: "6px 12px",
        borderRadius: 999,
        fontFamily: mono,
        fontSize: 11,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: on ? C.blue : C.t3,
          animation: status.streamingScreen ? "cueBlink 1.6s infinite" : undefined,
        }}
      />
      {label}
    </button>
  );
}

function Header({
  status,
  busy,
  onToggle,
}: {
  status: CueLiveStatus;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div>
        <div style={{ fontFamily: serif, fontSize: 30, color: C.t1 }}>
          Cue Live
        </div>
        <div
          style={{
            fontSize: 14,
            color: C.t2,
            marginTop: 4,
            lineHeight: 1.5,
            maxWidth: 560,
          }}
        >
          Cue on your screen. It reads what you&rsquo;re looking at to answer or
          capture context, and — when you ask — clicks and types for you. Summon
          it on any screen with{" "}
          <Keycap>{hotkeyGlyphs(status.hotkey)}</Keycap>.
        </div>
      </div>
      <StatusPill status={status} busy={busy} onToggle={onToggle} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. What it can do right now — a short, TRUE capability list                  */
/* -------------------------------------------------------------------------- */

interface Capability {
  readonly glyph: string;
  readonly name: string;
  readonly body: string;
  /** Honest gate note, when a grant/toggle is required for it to work. */
  readonly needs?: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    glyph: "👁",
    name: "Look",
    body: "Reads what's on screen and answers or summarizes it out loud. No control taken.",
    needs: "Screen Recording",
  },
  {
    glyph: "🧭",
    name: "Point",
    body: "Flies the cursor to the thing to act on next and labels it — you still do the click.",
  },
  {
    glyph: "✦",
    name: "Take control",
    body: "Clicks and types to finish a goal you state. Shows each move and pauses before anything irreversible.",
    needs: "the Take-control switch + both grants",
  },
  {
    glyph: "◫",
    name: "Stream to the web",
    body: "Mirrors this Mac to your Cue web session when you arm it there — a banner stays up the whole time.",
    needs: "Screen Recording",
  },
] as const;

function CapabilitiesCard() {
  return (
    <div style={card}>
      <div style={microLabel}>What it can do right now</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {CAPABILITIES.map((c) => (
          <div key={c.name} style={{ display: "flex", gap: 11 }}>
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
              {c.glyph}
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: C.t1,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {c.name}
                {c.needs ? (
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 9.5,
                      color: C.t3,
                      background: C.sunken,
                      border: `1px solid ${C.line}`,
                      borderRadius: 5,
                      padding: "1px 6px",
                      textTransform: "none",
                      letterSpacing: 0,
                    }}
                  >
                    needs {c.needs}
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: C.t2,
                  marginTop: 2,
                  lineHeight: 1.45,
                }}
              >
                {c.body}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: C.t3,
          marginTop: 14,
          paddingTop: 12,
          borderTop: `1px solid ${C.line}`,
          lineHeight: 1.5,
        }}
      >
        Not built yet: a hands-free wake word, watching one scoped window or the
        whole screen continuously, and waking an offline Mac from the browser.
        Those are off until they&rsquo;re real.
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Why the overlay appears — the "Cue Live randomly comes on" answer        */
/* -------------------------------------------------------------------------- */

function WhyOverlayCard({ hotkey }: { hotkey: string }) {
  return (
    <div
      style={{
        ...card,
        borderLeft: `3px solid ${C.blue}`,
        borderRadius: "0 14px 14px 0",
      }}
    >
      <div style={microLabel}>Why the overlay appears</div>
      <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.6 }}>
        You&rsquo;ll see a Cue card or a highlight ring on screen{" "}
        <b style={{ color: C.t1 }}>only when Cue is looking at or acting on your
        screen</b>{" "}
        — when you summon it (<Keycap>{hotkeyGlyphs(hotkey)}</Keycap>), when a
        task takes control, or when your screen is streaming to a Cue web session.
        It is not a background watcher and there is no chat keyword that triggers
        it; the overlay is simply the signal that Cue can see the screen right
        now. <b style={{ color: C.t1 }}>Esc — or Stop — ends it immediately.</b>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Turn it on / keys — the real bindings, compact                           */
/* -------------------------------------------------------------------------- */

function KeyRow({
  label,
  hint,
  cap,
  disabled,
  onClick,
  last,
}: {
  label: string;
  hint?: string;
  cap: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  last?: boolean;
}) {
  const interactive = Boolean(onClick) && !disabled;
  const Tag = interactive ? "button" : "div";
  return (
    <Tag
      {...(interactive ? { type: "button" as const, onClick } : {})}
      style={{
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 0",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        cursor: interactive ? "pointer" : "default",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: C.t1 }}>{label}</span>
        {hint ? <span style={{ fontSize: 10.5, color: C.t3 }}>{hint}</span> : null}
      </span>
      {cap}
    </Tag>
  );
}

function KeysCard({
  hotkey,
  onStop,
}: {
  hotkey: string;
  onStop: () => void;
}) {
  return (
    <div style={card}>
      <div style={microLabel}>Keys</div>
      <KeyRow label="Summon Cue" cap={<Keycap>{hotkeyGlyphs(hotkey)}</Keycap>} />
      <KeyRow
        label="Point at what's next"
        hint="Flies the cursor to the element to act on"
        cap={<Keycap>⌥ P</Keycap>}
      />
      <KeyRow
        label="Hold to talk"
        hint="Speak a goal aloud — set a voice under Voice first"
        cap={<Keycap>⌥ R</Keycap>}
      />
      <KeyRow
        label="Stop everything"
        hint="Click to stop now, or press Esc"
        onClick={onStop}
        cap={<Keycap>esc</Keycap>}
        last
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. Take control switch + Try it — the only interactive test, kept honest    */
/* -------------------------------------------------------------------------- */

function TakeControlCard({
  on,
  busy,
  onChange,
  blockedReason,
}: {
  on: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
  blockedReason: string | null;
}) {
  const blocked = Boolean(blockedReason);
  return (
    <div style={card}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            Let Cue take control
          </div>
          <div style={{ fontSize: 12.5, color: C.t2, marginTop: 3, lineHeight: 1.5 }}>
            Off by default. When on, a goal you state (spoken or typed) lets Cue
            click and type — pausing before anything irreversible.{" "}
            <b style={{ color: C.t1 }}>Stop always wins.</b>
          </div>
        </div>
        <Toggle
          on={on && !blocked}
          busy={busy || blocked}
          onChange={onChange}
          label="Let Cue take control"
        />
      </div>
      {blocked ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            lineHeight: 1.5,
            color: C.amber,
            background: `color-mix(in srgb, var(--mv1-amber) 12%, transparent)`,
            borderRadius: 8,
            padding: "8px 10px",
          }}
        >
          {blockedReason}
        </div>
      ) : null}
    </div>
  );
}

const GOAL_EXAMPLES: readonly { label: string; goal: string }[] = [
  {
    label: "Capture a to-do from my screen",
    goal: "Read what's on my screen and capture any to-dos or follow-ups you find.",
  },
  {
    label: "Explain this screen",
    goal: "What's on my screen right now, and what can I do here?",
  },
  {
    label: "Make a folder in Finder",
    goal: "In Finder, on the Desktop, create a new folder and name it Test.",
  },
] as const;

/** The one real interactive tester: summon, or run a typed goal (no mic). */
function TryItCard({ enabled }: { enabled: boolean }) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canRunGoal = isRunGoalSupported();

  const summon = async () => {
    setNote(null);
    await summonCueLive();
    setNote(
      "Summoned — move your cursor over a button or field and watch for the Cue card.",
    );
  };

  const run = async (takeControl: boolean) => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    setBusy(true);
    setNote(null);
    await runGoal(trimmed, takeControl);
    setBusy(false);
    setNote(
      takeControl
        ? "Running — watch the screen. Press Esc to stop it at any time."
        : "Looking — watch for the cursor to point and a card to appear.",
    );
  };

  return (
    <div style={card}>
      <div style={microLabel}>Try it</div>
      <p style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5, marginBottom: 12 }}>
        Summon Cue where your cursor is, or type a goal and run it — no
        microphone needed. &ldquo;Do it&rdquo; lets Cue click and type;
        &ldquo;Explain&rdquo; just points and describes.
      </p>

      <button
        type="button"
        disabled={!enabled}
        onClick={() => void summon()}
        style={{
          borderRadius: 8,
          background: C.blue,
          color: "#fff",
          padding: "7px 14px",
          fontSize: 13,
          fontWeight: 500,
          border: "none",
          cursor: enabled ? "pointer" : "default",
          opacity: enabled ? 1 : 0.5,
        }}
      >
        Summon Cue now
      </button>

      {canRunGoal ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
            {GOAL_EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => setGoal(ex.goal)}
                style={{
                  borderRadius: 999,
                  border: `1px solid ${C.line2}`,
                  padding: "4px 12px",
                  fontSize: 11.5,
                  color: C.t2,
                  background: C.surface,
                  cursor: "pointer",
                }}
              >
                {ex.label}
              </button>
            ))}
          </div>
          <textarea
            value={goal}
            disabled={busy || !enabled}
            rows={2}
            placeholder="e.g. Read my screen and capture any to-dos"
            onChange={(e) => setGoal(e.target.value)}
            style={{
              width: "100%",
              resize: "none",
              borderRadius: 10,
              border: `1px solid ${C.line}`,
              background: C.sunken,
              padding: "8px 12px",
              fontSize: 13,
              color: C.t1,
              outline: "none",
              marginTop: 10,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
            <button
              type="button"
              disabled={busy || !enabled || !goal.trim()}
              onClick={() => void run(true)}
              style={{
                borderRadius: 8,
                background: C.violetS,
                color: "#fff",
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 500,
                border: "none",
                cursor: busy || !enabled || !goal.trim() ? "default" : "pointer",
                opacity: busy || !enabled || !goal.trim() ? 0.5 : 1,
              }}
            >
              Do it
            </button>
            <button
              type="button"
              disabled={busy || !enabled || !goal.trim()}
              onClick={() => void run(false)}
              style={{
                borderRadius: 8,
                border: `1px solid ${C.line2}`,
                background: C.surface,
                padding: "6px 14px",
                fontSize: 13,
                color: C.t2,
                cursor: busy || !enabled || !goal.trim() ? "default" : "pointer",
                opacity: busy || !enabled || !goal.trim() ? 0.5 : 1,
              }}
            >
              Explain
            </button>
          </div>
        </>
      ) : null}

      {note ? (
        <div style={{ fontSize: 12, color: C.t2, marginTop: 12 }}>{note}</div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer — where control + the remote live                                    */
/* -------------------------------------------------------------------------- */

function FooterLinks() {
  return (
    <div
      style={{
        fontSize: 12, color: C.t3, lineHeight: 1.6,
        borderTop: `1px solid ${C.line}`, paddingTop: 12,
      }}
    >
      Every take-control action runs through the approvals model — draw the lines
      Cue works inside in{" "}
      <Link to={routes.guardrails} style={{ color: C.blueS, textDecoration: "none" }}>
        Guardrails
      </Link>
      . Watching a run from your phone or another browser? Open the{" "}
      <Link to={routes.desktopControl} style={{ color: C.blueS, textDecoration: "none" }}>
        live run remote
      </Link>
      .
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The on-desktop panel — composes the five answers, wired to real state       */
/* -------------------------------------------------------------------------- */

function DesktopControlPanel() {
  const [status, setStatus] = useState<CueLiveStatus | null>(null);
  const [permissions, setPermissions] = useState<CueLivePermissions | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await getCueLiveStatus());
    // The dedicated permissions IPC is the source of truth (both grants,
    // non-prompting). Older preloads lack it → fall back to the status flags,
    // erring toward "not granted" so a missing grant is never hidden.
    if (isCueLivePermissionsSupported()) {
      setPermissions(await getCueLivePermissions());
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Re-poll so a grant the user just made in System Settings is reflected
    // without a navigation — this is what makes the banner self-clear.
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!status) return null;

  const handleEnable = async (next: boolean) => {
    setBusy(true);
    const updated = await setCueLiveEnabled(next);
    if (updated) setStatus(updated);
    setBusy(false);
  };
  const handleTakeControl = async (next: boolean) => {
    setBusy(true);
    const updated = await setCueLiveTakeControl(next);
    if (updated) setStatus(updated);
    setBusy(false);
  };

  // Effective grants: the dedicated IPC when present, else synthesize from the
  // coarse status flag. When Screen Recording can't be read we say NOT granted —
  // never the reverse; a hidden banner over dead capture is exactly the failure
  // it exists to surface.
  const grants: CueLivePermissions = permissions ?? {
    accessibilityTrusted: status.accessibilityTrusted,
    screenRecordingGranted: status.screenRecordingGranted,
  };

  const takeControlBlocked = !grants.screenRecordingGranted
    ? "Needs Screen Recording — grant it above and this switches on."
    : !grants.accessibilityTrusted
      ? "Needs Accessibility — grant it above and this switches on."
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>
      <Header status={status} busy={busy} onToggle={() => void handleEnable(!status.enabled)} />

      {/* The blocking "it doesn't work" unblock — only while a grant is missing. */}
      {status.enabled ? <PermissionsBanner permissions={grants} /> : null}

      <CapabilitiesCard />
      <WhyOverlayCard hotkey={status.hotkey} />
      <TakeControlCard
        on={status.takeControl}
        busy={busy}
        onChange={(next) => void handleTakeControl(next)}
        blockedReason={takeControlBlocked}
      />
      <KeysCard hotkey={status.hotkey} onStop={() => void stopCueLive()} />
      <TryItCard enabled={status.enabled} />
      <FooterLinks />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Route entry — device-branched.                                              */
/*                                                                             */
/* On the Mac app: the panel above (the real controls + grants).               */
/* Off the desktop app: the explainer, which can never hold macOS grants, so   */
/* it points at the Mac and becomes the live remote viewer once a session runs.*/
/* -------------------------------------------------------------------------- */

export function CueLivePage() {
  const available = isCueLiveAvailable();
  return (
    <>
      <style>{`@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}`}</style>
      <div
        style={{
          fontFamily: "'DM Sans', system-ui, sans-serif",
          color: C.t1,
          paddingBottom: 24,
        }}
      >
        {available ? <DesktopControlPanel /> : <CueLiveWebExplainer />}
      </div>
    </>
  );
}
