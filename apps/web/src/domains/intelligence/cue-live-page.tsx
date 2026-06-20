import { Check, Mic, MousePointer2, Volume2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  CueLiveStatus,
  CueLiveVoiceKeyField,
  CueLiveVoiceKeysStatus,
} from "@vellumai/ipc-contract";

import {
  getCueLiveStatus,
  getVoiceKeysStatus,
  isCueLiveAvailable,
  isRunGoalSupported,
  runGoal,
  setCueLiveEnabled,
  setCueLiveTakeControl,
  setVoiceKey,
  summonCueLive,
} from "@/runtime/cue-live";

/* -------------------------------------------------------------------------- */
/* Design tokens (surfaces/CueLive.dc.html · HANDOFF.md)                       */
/* -------------------------------------------------------------------------- */

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueStrong: "#2B53C4",
  blueWash: "#DBE4FB",
  violet: "#7F77DD",
  violetStrong: "#534AB7",
  violetLine: "#D9D6F2",
  violetWash: "#FBFAFF",
  blueWashSoft: "#FAFBFF",
  green: "#277E41",
  danger: "#DA491A",
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  // right-rail ink card accents
  inkSub: "#C4CCDA",
  inkBlue: "#9DB4E6",
  dangerWash: "#FCEBEB",
  dangerLine: "#F0B9AC",
} as const;

const MONO = "'DM Mono', ui-monospace, monospace";

const sectionLabel: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  letterSpacing: ".1em",
  textTransform: "uppercase",
  color: C.t3,
  marginBottom: 11,
};

/* -------------------------------------------------------------------------- */
/* Keycap rendering (real Summon accelerator)                                 */
/* -------------------------------------------------------------------------- */

/** Split a hotkey accelerator ("Control+Option+Space") into glyphs. */
const KEYCAP_LABELS: Record<string, string> = {
  Control: "⌃",
  Ctrl: "⌃",
  Option: "⌥",
  Alt: "⌥",
  Command: "⌘",
  Cmd: "⌘",
  Shift: "⇧",
  Space: "Space",
};

/** Render an accelerator string as a single keycap pill matching the mock. */
function hotkeyGlyphs(hotkey: string): string {
  return hotkey
    .split("+")
    .map((p) => KEYCAP_LABELS[p] ?? p)
    .join(" ");
}

function Keycap({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "danger";
}) {
  const danger = tone === "danger";
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 11,
        background: danger ? C.dangerWash : C.sunken,
        border: `1px solid ${danger ? C.dangerLine : C.line2}`,
        color: danger ? C.danger : C.t1,
        borderRadius: 6,
        padding: "3px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Toggles                                                                     */
/* -------------------------------------------------------------------------- */

/** A real, interactive toggle (sky knob when on). */
function Toggle({
  on,
  busy,
  accent = "blue",
  onChange,
  label,
}: {
  on: boolean;
  busy?: boolean;
  accent?: "blue" | "violet";
  onChange: (next: boolean) => void;
  label: string;
}) {
  const onColor = accent === "violet" ? C.violetStrong : C.blue;
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
        background: on ? onColor : C.line2,
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

/** A non-interactive toggle rendered exactly per the mock (display-only). */
function ToggleStatic({
  on,
  accent = "blue",
}: {
  on: boolean;
  accent?: "blue" | "violet";
}) {
  const onColor = accent === "violet" ? C.violetStrong : C.blue;
  return (
    <span
      aria-hidden
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        background: on ? onColor : C.line2,
        position: "relative",
        flexShrink: 0,
        display: "inline-block",
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
        }}
      />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Mode selector — Companion is the shipped/active mode; the others are the    */
/* escalating roadmap modes, rendered per the mock but non-interactive.        */
/* -------------------------------------------------------------------------- */

interface CueMode {
  readonly name: string;
  readonly desc: string;
  readonly meta: string;
  readonly active?: boolean;
  readonly accent?: boolean;
}

const CUE_MODES: readonly CueMode[] = [
  {
    name: "Companion",
    desc: "Follows your cursor, passive until summoned.",
    meta: "AX only · most private",
    active: true,
  },
  {
    name: "Scoped watch",
    desc: "Point Cue at one window. Captures actions from just that.",
    meta: "bounded capture",
  },
  {
    name: "Always-on",
    desc: "Whole screen, continuous. Opt-in, visible light + one-tap pause.",
    meta: "AX + vision on change",
  },
  {
    name: "Take control",
    desc: "State a goal, Cue drives. Guided → autonomous, you approve.",
    meta: "checkpointed",
    accent: true,
  },
];

function ModeCards() {
  return (
    <div>
      <div style={sectionLabel}>Mode · escalating power + trust</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        {CUE_MODES.map((m) => (
          <div
            key={m.name}
            style={{
              border: m.active
                ? `2px solid ${C.blue}`
                : m.accent
                  ? `1px solid ${C.violetLine}`
                  : `1px solid ${C.line}`,
              borderRadius: 13,
              padding: 14,
              background: m.active
                ? C.blueWashSoft
                : m.accent
                  ? C.violetWash
                  : undefined,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: m.accent ? C.violetStrong : C.t1,
                }}
              >
                {m.name}
              </div>
              {m.active && (
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9.5,
                    background: C.blueWash,
                    color: C.blueStrong,
                    padding: "2px 7px",
                    borderRadius: 5,
                  }}
                >
                  ACTIVE
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: C.t2, marginTop: 4 }}>
              {m.desc}{" "}
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.t3 }}>
                {m.meta}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hotkeys — Summon is the real configured accelerator; the rest are the       */
/* mock's fixed bindings (no bridge field exposes them), shown display-only.   */
/* -------------------------------------------------------------------------- */

function HotkeyRow({
  label,
  cap,
  tone = "default",
  last = false,
}: {
  label: string;
  cap: React.ReactNode;
  tone?: "default" | "danger";
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "11px 14px",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
      }}
    >
      <span
        style={{
          fontSize: 13,
          color: tone === "danger" ? C.danger : C.t1,
          fontWeight: tone === "danger" ? 500 : 400,
        }}
      >
        {label}
      </span>
      {cap}
    </div>
  );
}

function HotkeysCard({ summonHotkey }: { summonHotkey: string }) {
  return (
    <div>
      <div style={sectionLabel}>Hotkeys</div>
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          overflow: "hidden",
        }}
      >
        <HotkeyRow
          label="Summon Cue"
          cap={<Keycap>{hotkeyGlyphs(summonHotkey)}</Keycap>}
        />
        <HotkeyRow label="Point at element" cap={<Keycap>⌥ P</Keycap>} />
        <HotkeyRow label="Push-to-talk" cap={<Keycap>hold fn</Keycap>} />
        <HotkeyRow
          label="Stop everything"
          tone="danger"
          last
          cap={
            <Keycap tone="danger">⌥ esc</Keycap>
          }
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Voice bindings — VAD + Read-selection have no backend (display-only per     */
/* honesty rule). Voice name reflects the real saved voice; "Change" opens the */
/* real voice-key / voice-id entry (VoiceSetup) below.                         */
/* -------------------------------------------------------------------------- */

function VoiceBindingsCard({
  voiceId,
  onChange,
}: {
  voiceId: string | null;
  onChange: () => void;
}) {
  const voiceLabel = voiceId ? voiceId : "Default";
  const voiceMeta = voiceId ? "custom · ElevenLabs" : "warm, low";
  return (
    <div>
      <div style={sectionLabel}>Voice bindings</div>
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 13,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              Hands-free (VAD)
            </div>
            <div style={{ fontSize: 11.5, color: C.t2 }}>
              Wake on voice, no key
            </div>
          </div>
          <ToggleStatic on={false} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              Read selection aloud
            </div>
            <div style={{ fontSize: 11.5, color: C.t2 }}>⌥ R on any text</div>
          </div>
          <ToggleStatic on />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Voice</div>
            <div
              style={{
                fontSize: 11.5,
                color: C.t2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 180,
              }}
            >
              {voiceLabel === "Default" ? '"Even"' : voiceLabel} · {voiceMeta}
            </div>
          </div>
          <button
            type="button"
            onClick={onChange}
            style={{
              fontSize: 12,
              border: `1px solid ${C.line2}`,
              borderRadius: 8,
              padding: "5px 10px",
              background: C.surface,
              color: C.t1,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Change
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Auto-run goals — no backend for a saved goal list, so we honour the         */
/* honesty rule: render the section header + the dashed add affordance, which  */
/* routes to the real typed-goal runner (VoiceSetup/GoalRunner) below.         */
/* -------------------------------------------------------------------------- */

function AutoRunGoals({ onAdd }: { onAdd: () => void }) {
  return (
    <div>
      <div style={sectionLabel}>Auto-run goals</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <button
          type="button"
          onClick={onAdd}
          style={{
            border: `1px dashed ${C.line2}`,
            borderRadius: 12,
            padding: "12px 14px",
            fontSize: 12.5,
            color: C.t3,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          + Add an auto-run goal
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Right rail — Take control (real toggle) + How it sees + trust note          */
/* -------------------------------------------------------------------------- */

function TakeControlCard({
  on,
  busy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div>
      <div style={sectionLabel}>Take control</div>
      <div
        style={{
          background: C.ink,
          color: "#fff",
          borderRadius: 14,
          padding: 15,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 500 }}>Allow Cue to act</div>
          <Toggle
            on={on}
            busy={busy}
            accent="violet"
            onChange={onChange}
            label="Allow Cue to act"
          />
        </div>
        <div
          style={{
            fontSize: 12,
            color: C.inkBlue,
            marginTop: 7,
            lineHeight: 1.55,
          }}
        >
          Cue can drive apps toward a goal you state. Guarded steps pause for
          approval — <b style={{ color: "#fff" }}>Stop always wins.</b>
        </div>
        <div
          style={{
            marginTop: 11,
            display: "flex",
            flexDirection: "column",
            gap: 7,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: C.inkSub,
            }}
          >
            <span>Pause before sending</span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.inkBlue }}>
              always
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: C.inkSub,
            }}
          >
            <span>Pause before purchases</span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.inkBlue }}>
              always
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function HowItSeesCard() {
  return (
    <div>
      <div style={sectionLabel}>How it sees</div>
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          padding: 14,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500 }}>Accessibility-first</div>
        <div
          style={{
            fontSize: 12,
            color: C.t2,
            marginTop: 4,
            lineHeight: 1.55,
          }}
        >
          ~50ms AX reads. Screenshots only when AX is blind, only on change.
        </div>
        <div
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 12,
          }}
        >
          <span>Screen capture</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.t2 }}>
            on change only
          </span>
        </div>
        <div
          style={{
            marginTop: 7,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 12,
          }}
        >
          <span>Password fields</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.green }}>
            never captured
          </span>
        </div>
      </div>
    </div>
  );
}

function TrustNote() {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${C.blue}`,
        borderRadius: "0 12px 12px 0",
        padding: "11px 14px",
        fontSize: 12,
        color: C.t2,
        marginTop: "auto",
      }}
    >
      Every action runs through the approvals model. Manage who can reach Cue in
      the{" "}
      <Link
        to="/assistant/trust"
        style={{ color: C.blueStrong, textDecoration: "none" }}
      >
        Trust console
      </Link>
      .
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Voice setup — REAL voice-key + voice-id entry (AssemblyAI + ElevenLabs).    */
/* Stored encrypted in the Keychain via the bridge. Opened from "Change" /     */
/* "Add an auto-run goal" affordances. Never fabricated.                       */
/* -------------------------------------------------------------------------- */

function SecretKeyField({
  field,
  icon: Icon,
  label,
  help,
  link,
  configured,
  onSaved,
}: {
  field: CueLiveVoiceKeyField;
  icon: typeof Mic;
  label: string;
  help: string;
  link: string;
  configured: boolean;
  onSaved: (status: CueLiveVoiceKeysStatus | null) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (next: string | null) => {
    setBusy(true);
    onSaved(await setVoiceKey(field, next));
    setValue("");
    setBusy(false);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        background: C.surface,
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon className="size-4" style={{ color: C.blue }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>
            {label}
          </span>
        </div>
        {configured && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              fontWeight: 500,
              color: C.blue,
            }}
          >
            <Check className="size-3.5" /> Saved
          </span>
        )}
      </div>
      <p style={{ fontSize: 12, lineHeight: 1.4, color: C.t2 }}>
        {help}{" "}
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          style={{ color: C.blue, textDecoration: "underline" }}
        >
          Get a key
        </a>
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="password"
          value={value}
          disabled={busy}
          placeholder={configured ? "•••••••• (saved)" : "Paste API key"}
          onChange={(e) => setValue(e.target.value)}
          style={{
            minWidth: 0,
            flex: 1,
            borderRadius: 8,
            border: `1px solid ${C.line}`,
            background: C.sunken,
            padding: "6px 12px",
            fontSize: 13,
            color: C.t1,
            outline: "none",
          }}
        />
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => void save(value)}
          style={{
            borderRadius: 8,
            background: C.blue,
            color: "#fff",
            padding: "6px 12px",
            fontSize: 13,
            fontWeight: 500,
            border: "none",
            cursor: busy || !value.trim() ? "default" : "pointer",
            opacity: busy || !value.trim() ? 0.5 : 1,
          }}
        >
          Save
        </button>
        {configured && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            style={{
              borderRadius: 8,
              border: `1px solid ${C.line2}`,
              background: C.surface,
              padding: "6px 12px",
              fontSize: 13,
              color: C.t2,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function VoiceSetup({
  status,
  onStatus,
}: {
  status: CueLiveVoiceKeysStatus;
  onStatus: (s: CueLiveVoiceKeysStatus | null) => void;
}) {
  const [voiceId, setVoiceId] = useState(status.elevenLabsVoiceId ?? "");
  const [savingVoiceId, setSavingVoiceId] = useState(false);

  const saveVoiceId = async () => {
    setSavingVoiceId(true);
    onStatus(await setVoiceKey("elevenLabsVoiceId", voiceId || null));
    setSavingVoiceId(false);
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={sectionLabel}>Voice setup</div>
        <p style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5 }}>
          Cue Live talks with you using your own API keys. Paste them once —
          they're stored encrypted in your Keychain. Until they're set, summon
          still works silently (it shows the answer as a card).
        </p>
      </div>
      <SecretKeyField
        field="assemblyAi"
        icon={Mic}
        label="AssemblyAI — speech to text"
        help="Lets you hold ⌃⌥ and ask out loud."
        link="https://www.assemblyai.com/dashboard/api-keys"
        configured={status.hasAssemblyAi}
        onSaved={onStatus}
      />
      <SecretKeyField
        field="elevenLabs"
        icon={Volume2}
        label="ElevenLabs — text to speech"
        help="Lets Cue answer back in a natural voice."
        link="https://elevenlabs.io/app/settings/api-keys"
        configured={status.hasElevenLabs}
        onSaved={onStatus}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          background: C.surface,
          padding: 14,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>
          ElevenLabs voice (optional)
        </span>
        <p style={{ fontSize: 12, lineHeight: 1.4, color: C.t2 }}>
          A voice ID from your ElevenLabs voice library. Leave blank for the
          default voice.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="text"
            value={voiceId}
            disabled={savingVoiceId}
            placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
            onChange={(e) => setVoiceId(e.target.value)}
            style={{
              minWidth: 0,
              flex: 1,
              borderRadius: 8,
              border: `1px solid ${C.line}`,
              background: C.sunken,
              padding: "6px 12px",
              fontSize: 13,
              color: C.t1,
              outline: "none",
            }}
          />
          <button
            type="button"
            disabled={savingVoiceId}
            onClick={() => void saveVoiceId()}
            style={{
              borderRadius: 8,
              background: C.blue,
              color: "#fff",
              padding: "6px 12px",
              fontSize: 13,
              fontWeight: 500,
              border: "none",
              cursor: savingVoiceId ? "default" : "pointer",
              opacity: savingVoiceId ? 0.5 : 1,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Goal runner — REAL typed-goal test (no mic). "Do it" engages the act loop;  */
/* "Explain" points + describes. Newer preloads only.                          */
/* -------------------------------------------------------------------------- */

const GOAL_EXAMPLES: readonly {
  label: string;
  goal: string;
}[] = [
  {
    label: "Notes — write a note",
    goal: "Open the Notes app, create a new note, and type a short three-item grocery list.",
  },
  {
    label: "Finder — make a folder",
    goal: "In Finder, on the Desktop, create a new folder and name it Test.",
  },
  {
    label: "Explain this screen",
    goal: "What's on my screen right now, and what can I do here?",
  },
];

function GoalRunner() {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!isRunGoalSupported()) return null;

  const run = async (text: string, takeControl: boolean) => {
    const trimmed = text.trim();
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
    <section style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div>
        <div style={sectionLabel}>Run a goal</div>
        <p style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5 }}>
          Type a goal and run it — no microphone needed. "Do it" lets Cue click
          and type to complete the task; "Explain" just points and describes.
        </p>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
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
        disabled={busy}
        rows={2}
        placeholder="e.g. Open Notes and write a grocery list"
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
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          disabled={busy || !goal.trim()}
          onClick={() => void run(goal, true)}
          style={{
            borderRadius: 8,
            background: C.violetStrong,
            color: "#fff",
            padding: "6px 14px",
            fontSize: 13,
            fontWeight: 500,
            border: "none",
            cursor: busy || !goal.trim() ? "default" : "pointer",
            opacity: busy || !goal.trim() ? 0.5 : 1,
          }}
        >
          Do it
        </button>
        <button
          type="button"
          disabled={busy || !goal.trim()}
          onClick={() => void run(goal, false)}
          style={{
            borderRadius: 8,
            border: `1px solid ${C.line2}`,
            background: C.surface,
            padding: "6px 14px",
            fontSize: 13,
            color: C.t2,
            cursor: busy || !goal.trim() ? "default" : "pointer",
            opacity: busy || !goal.trim() ? 0.5 : 1,
          }}
        >
          Explain
        </button>
        {note && <span style={{ fontSize: 12, color: C.t2 }}>{note}</span>}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Desktop control panel — the mock's center column + right rail              */
/* -------------------------------------------------------------------------- */

function DesktopControlPanel() {
  const [status, setStatus] = useState<CueLiveStatus | null>(null);
  const [voiceKeys, setVoiceKeys] = useState<CueLiveVoiceKeysStatus | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [summonNote, setSummonNote] = useState<string | null>(null);
  const [showVoiceSetup, setShowVoiceSetup] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await getCueLiveStatus());
  }, []);

  useEffect(() => {
    void refresh();
    // Re-poll while mounted so the Accessibility state reflects a grant the
    // user just made in System Settings without needing a navigation.
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    void (async () => setVoiceKeys(await getVoiceKeysStatus()))();
  }, []);

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

  const handleSummon = async () => {
    setSummonNote(null);
    await summonCueLive();
    setSummonNote(
      "Summoned — move your cursor over a button or field and look for the Cue card.",
    );
  };

  const openVoiceSetup = () => setShowVoiceSetup(true);

  // The mock's status pill: "running · companion" when live. The shipped mode
  // is always Companion, so we surface that. We reflect the *real* run state.
  const pillRunning = status.enabled && status.running;
  const pillLabel = pillRunning
    ? "running · companion"
    : status.enabled
      ? "idle · companion"
      : "off";
  const pillOn = status.enabled;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 280px",
        gap: 22,
        alignItems: "start",
      }}
    >
      {/* CENTER */}
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 500,
                letterSpacing: "-.4px",
                color: C.t1,
              }}
            >
              Cue Live
            </div>
            <div style={{ fontSize: 13, color: C.t2, marginTop: 2 }}>
              The presence that lives on your screen — guides you, or takes the
              wheel.
            </div>
          </div>
          {/* Status pill doubles as the real enable/disable control. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleEnable(!status.enabled)}
            title={status.enabled ? "Turn Cue Live off" : "Turn Cue Live on"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: pillOn ? "rgba(61,110,232,.1)" : C.sunken,
              border: `1px solid ${pillOn ? "rgba(61,110,232,.4)" : C.line2}`,
              color: pillOn ? C.blueStrong : C.t3,
              padding: "6px 12px",
              borderRadius: 999,
              fontFamily: MONO,
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
                background: pillOn ? C.blue : C.t3,
                animation: pillRunning ? "cueBlink 1.6s infinite" : undefined,
              }}
            />
            {pillLabel}
          </button>
        </div>

        <ModeCards />

        {/* Accessibility prompt — only when enabled but not yet trusted. */}
        {status.enabled && !status.accessibilityTrusted && (
          <div
            style={{
              borderRadius: 12,
              padding: "11px 14px",
              fontSize: 12,
              lineHeight: 1.5,
              color: C.danger,
              background: C.dangerWash,
              border: `1px solid ${C.dangerLine}`,
            }}
          >
            To arm the summon hotkey, enable <strong>Cue</strong> under System
            Settings → Privacy &amp; Security → Accessibility.
          </div>
        )}

        {/* Hotkeys + Voice bindings */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 18,
          }}
        >
          <HotkeysCard summonHotkey={status.hotkey} />
          <VoiceBindingsCard
            voiceId={voiceKeys?.elevenLabsVoiceId ?? null}
            onChange={openVoiceSetup}
          />
        </div>

        <AutoRunGoals onAdd={openVoiceSetup} />

        {/* Real summon test — keeps the working "Try it" control. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            disabled={!status.enabled}
            onClick={() => void handleSummon()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              borderRadius: 8,
              background: C.blue,
              color: "#fff",
              padding: "7px 14px",
              fontSize: 13,
              fontWeight: 500,
              border: "none",
              cursor: status.enabled ? "pointer" : "default",
              opacity: status.enabled ? 1 : 0.5,
            }}
          >
            Try it now
          </button>
          {summonNote && (
            <span style={{ fontSize: 12, color: C.t2 }}>{summonNote}</span>
          )}
        </div>

        {/* Real typed-goal runner (newer preloads only). */}
        <GoalRunner />

        {/* Real voice-key entry, revealed by Change / Add-goal affordances. */}
        {showVoiceSetup && voiceKeys && (
          <VoiceSetup status={voiceKeys} onStatus={setVoiceKeys} />
        )}
      </div>

      {/* RIGHT RAIL */}
      <aside
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          alignSelf: "stretch",
          minHeight: "100%",
        }}
      >
        <TakeControlCard
          on={status.takeControl}
          busy={busy}
          onChange={(next) => void handleTakeControl(next)}
        />
        <HowItSeesCard />
        <TrustNote />
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Web fallback — Cue Live is macOS-only. Keep this explainer.                 */
/* -------------------------------------------------------------------------- */

function UnavailableNotice() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        borderRadius: 14,
        border: `1px solid ${C.line}`,
        background: C.sunken,
        padding: 20,
      }}
    >
      <MousePointer2 className="size-5" style={{ color: C.t3 }} />
      <p style={{ fontSize: 13.5, color: C.t2, lineHeight: 1.5 }}>
        Cue Live is a macOS desktop feature. Open Cue on your Mac to turn it on
        and summon it over any app.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function CueLivePage() {
  const available = isCueLiveAvailable();

  return (
    <>
      {/* Local keyframes for the blinking status dot (mock: cueBlink). */}
      <style>{`@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}`}</style>
      <div
        style={{
          fontFamily: "'DM Sans', system-ui, sans-serif",
          color: C.t1,
          paddingBottom: 24,
        }}
      >
        {available ? <DesktopControlPanel /> : <UnavailableNotice />}
      </div>
    </>
  );
}
