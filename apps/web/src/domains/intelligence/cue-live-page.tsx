import { Lock, Mic, ShieldAlert, Volume2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  CueLiveGoal,
  CueLivePermissions,
  CueLiveSettingsPane,
  CueLiveStatus,
  CueLiveVoiceKeysStatus,
} from "@vellumai/ipc-contract";

import { CueLiveWebExplainer } from "@/domains/intelligence/cue-live-explainer";
import { hotkeyGlyphs } from "@/domains/intelligence/cue-live-hotkey";
import {
  deleteCueLiveGoal,
  getCueLivePermissions,
  getCueLiveStatus,
  getVoiceKeysStatus,
  isCueLiveAvailable,
  isCueLiveGoalsSupported,
  isCueLivePermissionsSupported,
  isRunGoalSupported,
  listCueLiveGoals,
  openCueLiveSystemSettings,
  runGoal,
  saveCueLiveGoal,
  setCueLiveEnabled,
  setCueLiveTakeControl,
  stopCueLive,
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
  // needs-you (the grant flow) is amber, not danger red — red is reserved for
  // a failure, and a permission Cue has simply not been given yet isn't one.
  amber: "#C98A1B",
  danger: "#DA491A",
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#9AA6B2",
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
/*                                                                            */
/* `hotkeyGlyphs` lives in cue-live-hotkey.tsx so the off-desktop explainer    */
/* renders the identical accelerator. This local `Keycap` keeps the desktop    */
/* panel's own (light, non-token) palette.                                     */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Mode selector                                                               */
/*                                                                             */
/* Honesty rule: only the modes the native engine actually backs are           */
/* selectable.                                                                  */
/*   - Companion: the shipped passive-until-summoned mode — always available.  */
/*   - Take control: backed by the real `setTakeControl` toggle (the act loop).*/
/*     Selecting it flips take-control ON; it reflects the persisted state.    */
/*   - Scoped watch / Always-on: no native implementation yet → DISABLED with  */
/*     a "Coming soon" affordance, never selectable.                           */
/* -------------------------------------------------------------------------- */

type CueModeId = "companion" | "takeControl" | "scoped" | "alwaysOn";

interface CueMode {
  readonly id: CueModeId;
  readonly name: string;
  readonly desc: string;
  readonly meta: string;
  /** Wired to a real capability (selectable). Otherwise it's "coming soon". */
  readonly supported: boolean;
  readonly accent?: boolean;
}

const CUE_MODES: readonly CueMode[] = [
  {
    id: "companion",
    name: "Companion",
    desc: "Follows your cursor, passive until summoned.",
    meta: "AX only · most private",
    supported: true,
  },
  {
    id: "scoped",
    name: "Scoped watch",
    desc: "Point Cue at one window. Captures actions from just that.",
    meta: "bounded capture",
    supported: false,
  },
  {
    id: "alwaysOn",
    name: "Always-on",
    desc: "Whole screen, continuous. Opt-in, visible light + one-tap pause.",
    meta: "AX + vision on change",
    supported: false,
  },
  {
    id: "takeControl",
    name: "Take control",
    desc: "State a goal, Cue drives. Guided → autonomous, you approve.",
    meta: "checkpointed",
    supported: true,
    accent: true,
  },
];

function ComingSoonTag() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: MONO,
        fontSize: 9.5,
        background: C.sunken,
        color: C.t3,
        padding: "2px 7px",
        borderRadius: 5,
      }}
    >
      <Lock className="size-2.5" /> SOON
    </span>
  );
}

/**
 * Mode cards. Companion is active whenever Cue Live is enabled; "Take control"
 * reflects (and toggles) the real take-control capability. The two unbuilt
 * modes render disabled with a "Coming soon" tag — never selectable.
 */
function ModeCards({
  takeControlOn,
  busy,
  onSelectTakeControl,
}: {
  takeControlOn: boolean;
  busy: boolean;
  onSelectTakeControl: (next: boolean) => void;
}) {
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
        {CUE_MODES.map((m) => {
          // "Active" = the mode reflecting current real state. Companion is the
          // baseline; Take control is active when the capability is on.
          const active =
            m.id === "companion"
              ? !takeControlOn
              : m.id === "takeControl" && takeControlOn;
          const selectable = m.supported && !busy;
          const onClick = () => {
            if (m.id === "takeControl") onSelectTakeControl(true);
            else if (m.id === "companion") onSelectTakeControl(false);
          };
          return (
            <button
              key={m.id}
              type="button"
              disabled={!selectable}
              aria-pressed={active}
              onClick={selectable ? onClick : undefined}
              title={
                m.supported
                  ? undefined
                  : "Not available yet — this mode needs a native capability that isn't built."
              }
              style={{
                textAlign: "left",
                border: active
                  ? m.accent
                    ? `2px solid ${C.violetStrong}`
                    : `2px solid ${C.blue}`
                  : m.accent
                    ? `1px solid ${C.violetLine}`
                    : `1px solid ${C.line}`,
                borderRadius: 13,
                padding: 14,
                background: active
                  ? m.accent
                    ? C.violetWash
                    : C.blueWashSoft
                  : m.supported
                    ? C.surface
                    : C.sunken,
                cursor: selectable ? "pointer" : "default",
                opacity: m.supported ? 1 : 0.65,
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
                {active ? (
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 9.5,
                      background: m.accent ? C.violetLine : C.blueWash,
                      color: m.accent ? C.violetStrong : C.blueStrong,
                      padding: "2px 7px",
                      borderRadius: 5,
                    }}
                  >
                    ACTIVE
                  </span>
                ) : !m.supported ? (
                  <ComingSoonTag />
                ) : null}
              </div>
              <div style={{ fontSize: 12, color: C.t2, marginTop: 4 }}>
                {m.desc}{" "}
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.t3 }}>
                  {m.meta}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hotkeys                                                                     */
/*                                                                             */
/* Honesty rule: labels reflect what the helper actually binds.                */
/*   - Summon: the real configured accelerator (⌃⌥Space), reported by status.  */
/*   - Push-to-talk: the helper's CuePushToTalkMonitor fires on HOLD ⌃⌥ (not   */
/*     "hold fn", which was wrong) — only active once voice keys are set.       */
/*   - Stop everything: the helper aborts an auto-run on Esc; the row is also a */
/*     live button (calls stopCueLive), so it works without overlay focus.     */
/*   - Point at element (⌥P): NOT implemented in the helper → disabled "soon".  */
/* -------------------------------------------------------------------------- */

function HotkeyRow({
  label,
  cap,
  tone = "default",
  disabled = false,
  hint,
  onClick,
  last = false,
}: {
  label: string;
  cap: React.ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  hint?: string;
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
        padding: "11px 14px",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        cursor: interactive ? "pointer" : "default",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 1,
          minWidth: 0,
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
        {hint && <span style={{ fontSize: 10.5, color: C.t3 }}>{hint}</span>}
      </span>
      {cap}
    </Tag>
  );
}

function HotkeysCard({
  summonHotkey,
  voiceReady,
  onStop,
}: {
  summonHotkey: string;
  voiceReady: boolean;
  onStop: () => void;
}) {
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
        <HotkeyRow
          label="Point at element"
          hint="Flies the cursor to what to do next"
          cap={<Keycap>⌥ P</Keycap>}
        />
        <HotkeyRow
          label="Push-to-talk"
          hint={
            voiceReady
              ? "Hold to speak a goal"
              : "Add a speech key in Voice setup to enable"
          }
          disabled={!voiceReady}
          cap={<Keycap>hold ⌃ ⌥</Keycap>}
        />
        <HotkeyRow
          label="Stop everything"
          tone="danger"
          hint="Click to stop now, or press Esc"
          last
          onClick={onStop}
          cap={<Keycap tone="danger">esc</Keycap>}
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
          <ComingSoonTag />
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
            <div style={{ fontSize: 11.5, color: C.t2 }}>Highlight + speak</div>
          </div>
          <ComingSoonTag />
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
/* Auto-run goals — a persisted list of named goals, each re-runnable on demand */
/* through the existing runGoal executor. CRUD is backed by the cueLiveGoals    */
/* setting via the bridge; the inline form adds/edits without leaving the page. */
/* -------------------------------------------------------------------------- */

function AutoRunGoals() {
  const [goals, setGoals] = useState<CueLiveGoal[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [goalText, setGoalText] = useState("");
  const [takeControl, setTakeControl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    if (!isCueLiveGoalsSupported()) return;
    let alive = true;
    void listCueLiveGoals().then((list) => {
      if (alive) setGoals(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const resetForm = () => {
    setAdding(false);
    setLabel("");
    setGoalText("");
    setTakeControl(false);
  };

  const save = async () => {
    const trimmedLabel = label.trim();
    const trimmedGoal = goalText.trim();
    if (!trimmedLabel || !trimmedGoal) return;
    setBusy(true);
    const next = await saveCueLiveGoal({
      label: trimmedLabel,
      goal: trimmedGoal,
      takeControl,
    });
    setGoals(next);
    setBusy(false);
    resetForm();
  };

  const remove = async (id: string) => {
    const next = await deleteCueLiveGoal(id);
    setGoals(next);
  };

  const run = async (g: CueLiveGoal) => {
    if (!isRunGoalSupported()) return;
    setRunningId(g.id);
    await runGoal(g.goal, g.takeControl);
    setRunningId(null);
  };

  // Off newer-preload desktops the goals IPC is absent; keep the section quiet
  // rather than render dead controls.
  if (!isCueLiveGoalsSupported()) return null;

  return (
    <div>
      <div style={sectionLabel}>Auto-run goals</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {goals.map((g) => (
          <div
            key={g.id}
            style={{
              border: `1px solid ${C.line}`,
              borderRadius: 12,
              padding: "11px 13px",
              background: C.surface,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                flexShrink: 0,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                color: g.takeControl ? C.violetStrong : C.blueStrong,
                background: g.takeControl ? C.violetWash : C.blueWash,
              }}
            >
              {g.takeControl ? "✦" : "✉"}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: C.t1,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                {g.label}
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 0.2,
                    textTransform: "uppercase",
                    color: g.takeControl ? C.violetStrong : C.t3,
                    background: g.takeControl ? C.violetWash : C.sunken,
                    border: `1px solid ${g.takeControl ? C.violetLine : C.line2}`,
                    borderRadius: 999,
                    padding: "1px 7px",
                  }}
                >
                  {g.takeControl ? "Do it" : "Explain"}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: C.t2,
                  marginTop: 3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {g.goal}
              </div>
            </div>
            <button
              type="button"
              disabled={runningId !== null}
              onClick={() => void run(g)}
              style={{
                flexShrink: 0,
                borderRadius: 8,
                background: C.violetStrong,
                color: "#fff",
                padding: "5px 13px",
                fontSize: 12,
                fontWeight: 500,
                border: "none",
                cursor: runningId !== null ? "default" : "pointer",
                opacity: runningId !== null ? 0.5 : 1,
              }}
            >
              {runningId === g.id ? "Running…" : "Run"}
            </button>
            <button
              type="button"
              aria-label={`Remove ${g.label}`}
              onClick={() => void remove(g.id)}
              style={{
                flexShrink: 0,
                border: `1px solid ${C.line2}`,
                borderRadius: 8,
                background: C.surface,
                color: C.t3,
                padding: "5px 9px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Remove
            </button>
          </div>
        ))}

        {adding ? (
          <div
            style={{
              border: `1px solid ${C.line2}`,
              borderRadius: 12,
              padding: 13,
              background: C.surface,
              display: "flex",
              flexDirection: "column",
              gap: 9,
            }}
          >
            <input
              value={label}
              disabled={busy}
              placeholder="Label (e.g. Triage inbox)"
              onChange={(e) => setLabel(e.target.value)}
              style={{
                width: "100%",
                borderRadius: 8,
                border: `1px solid ${C.line}`,
                background: C.sunken,
                padding: "7px 11px",
                fontSize: 12.5,
                color: C.t1,
                outline: "none",
              }}
            />
            <textarea
              value={goalText}
              disabled={busy}
              rows={2}
              placeholder="Goal — e.g. Open Notes and write a grocery list"
              onChange={(e) => setGoalText(e.target.value)}
              style={{
                width: "100%",
                resize: "none",
                borderRadius: 8,
                border: `1px solid ${C.line}`,
                background: C.sunken,
                padding: "7px 11px",
                fontSize: 12.5,
                color: C.t1,
                outline: "none",
              }}
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: C.t2,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={takeControl}
                disabled={busy}
                onChange={(e) => setTakeControl(e.target.checked)}
              />
              Take control (click &amp; type) when this runs
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <button
                type="button"
                disabled={busy || !label.trim() || !goalText.trim()}
                onClick={() => void save()}
                style={{
                  borderRadius: 8,
                  background: C.violetStrong,
                  color: "#fff",
                  padding: "6px 14px",
                  fontSize: 12.5,
                  fontWeight: 500,
                  border: "none",
                  cursor:
                    busy || !label.trim() || !goalText.trim()
                      ? "default"
                      : "pointer",
                  opacity: busy || !label.trim() || !goalText.trim() ? 0.5 : 1,
                }}
              >
                Save goal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={resetForm}
                style={{
                  borderRadius: 8,
                  border: `1px solid ${C.line2}`,
                  background: C.surface,
                  padding: "6px 14px",
                  fontSize: 12.5,
                  color: C.t2,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
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
        )}
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
  blockedReason,
}: {
  on: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
  /** Set when a missing macOS grant means Cue physically cannot act. */
  blockedReason?: string | null;
}) {
  const blocked = Boolean(blockedReason);
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
          {/* Blocked = a macOS grant is missing, so flipping this would switch
              the mode to one that can't do anything. Say so instead of
              pretending the switch worked. */}
          <Toggle
            on={on && !blocked}
            busy={busy || blocked}
            accent="violet"
            onChange={onChange}
            label="Allow Cue to act"
          />
        </div>
        {blocked ? (
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              lineHeight: 1.5,
              color: "#fff",
              background: "rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "7px 9px",
            }}
          >
            {blockedReason}
          </div>
        ) : null}
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
      Every action runs through the approvals model. Draw the lines Cue works
      inside in{" "}
      <Link
        to="/assistant/guardrails"
        style={{ color: C.blueStrong, textDecoration: "none" }}
      >
        Guardrails
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

function VoiceSetup() {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={sectionLabel}>Voice setup</div>
        <p style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5 }}>
          Cue Live speaks and listens with the voice you set under Voice —
          nothing to paste here. Set it once and every surface follows.
        </p>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          background: C.surface,
          padding: 14,
        }}
      >
        <Volume2 size={16} color={C.t2} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>
            Speaking — uses your Voice settings
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.4, color: C.t2 }}>
            Cue answers aloud in the voice configured under Voice. Change it
            there and Cue Live follows.
          </p>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          background: C.surface,
          padding: 14,
        }}
      >
        <Mic size={16} color={C.t2} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>
            Asking out loud — uses your Voice settings
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.4, color: C.t2 }}>
            Hold ⌃⌥ and speak. Cue transcribes with the speech-to-text provider
            configured under Voice.
          </p>
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
/* Permissions onboarding — the most important "it doesn't work" unblock.      */
/*                                                                             */
/* Cue Live can't see or act without two macOS grants. We read them            */
/* non-prompting from the helper and, when either is missing, show a BLOCKING  */
/* banner with a one-click deep-link to the exact System Settings pane. The    */
/* banner explains what each grant unlocks so the user knows why it matters.   */
/* -------------------------------------------------------------------------- */

/**
 * One row of the sequential grant flow (frame L3).
 *
 * `stage` is the whole point: exactly one un-granted row is ever "next", and
 * only that row carries a lit action. Rows behind it read ✓ Granted; rows
 * ahead of it are dimmed and actionless, so there is never a choice of two
 * buttons and never a wall of red.
 */
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
            style={{
              fontSize: 12,
              color: C.t2,
              marginTop: 2,
              lineHeight: 1.45,
            }}
          >
            {detail}
          </div>
        </div>
      </div>
      {granted ? (
        <span
          style={{
            flexShrink: 0,
            fontFamily: MONO,
            fontSize: 11,
            color: C.green,
          }}
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
 * The grant flow (frame L3) — grant-then-it-works, one step at a time.
 *
 * Screen Recording leads because it is what "Cue can't see anything" actually
 * means; Accessibility follows because clicking is the second capability. It
 * disappears entirely once both are held.
 */
export function PermissionsBanner({
  permissions,
}: {
  permissions: CueLivePermissions;
}) {
  const screen = permissions.screenRecordingGranted;
  const access = permissions.accessibilityTrusted;
  if (screen && access) return null;

  // Exactly one "next": the first un-granted step in order.
  const screenStage = screen ? "granted" : "next";
  const accessStage = access ? "granted" : screen ? "next" : "later";

  return (
    <div
      style={{
        borderRadius: 14,
        border: `1px solid color-mix(in srgb, ${C.amber} 45%, transparent)`,
        background: `color-mix(in srgb, ${C.amber} 9%, ${C.surface})`,
        padding: "16px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <ShieldAlert className="size-5" style={{ color: C.amber }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>
          Let Cue see &amp; act on your screen
        </div>
      </div>
      <div
        style={{ fontSize: 12.5, color: C.t2, marginTop: 6, lineHeight: 1.5 }}
      >
        Two macOS permissions, granted once. Cue only looks when you summon it —
        nothing runs in the background. Until then, summon and &ldquo;Do
        it&rdquo; do nothing.
      </div>
      <div
        style={{
          marginTop: 10,
          borderTop: `1px solid color-mix(in srgb, ${C.amber} 30%, transparent)`,
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
            borderTop: `1px solid color-mix(in srgb, ${C.amber} 30%, transparent)`,
          }}
        />
        <PermissionRow
          stage={accessStage}
          title="Accessibility"
          detail="so Cue can click & type for you — and so the summon hotkey is armed."
          pane="accessibility"
        />
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: C.t3,
          marginTop: 10,
          lineHeight: 1.5,
        }}
      >
        Opens System Settings → Privacy &amp; Security. Cue can&rsquo;t grant
        these for you — macOS asks you directly. This page updates on its own
        once you do.
      </div>
    </div>
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
  const [permissions, setPermissions] = useState<CueLivePermissions | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setStatus(await getCueLiveStatus());
    // The dedicated permissions IPC is the source of truth (it reads both AX +
    // Screen Recording, non-prompting). Fall back to the coarser status flag on
    // older preloads that lack it.
    if (isCueLivePermissionsSupported()) {
      setPermissions(await getCueLivePermissions());
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Re-poll while mounted so a grant the user just made in System Settings is
    // reflected without needing a navigation — drives the onboarding banner.
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

  const handleStop = () => {
    setSummonNote("Stopped — Cue Live is idle.");
    void stopCueLive();
  };

  const openVoiceSetup = () => setShowVoiceSetup(true);

  // Effective permissions: the dedicated IPC when present, else synthesize from
  // the status flag. When we can't read Screen Recording we say NOT granted —
  // never the reverse. Claiming a grant we haven't substantiated hid the
  // permissions banner while capture was silently dead, which is exactly the
  // state the banner exists to surface. An unnecessary banner is a small cost;
  // a hidden one strands the user with a feature that quietly does nothing.
  const effectivePermissions: CueLivePermissions = permissions ?? {
    accessibilityTrusted: status.accessibilityTrusted,
    screenRecordingGranted: false,
  };
  // Speech now runs on the assistant, so there is no local key to gate on.
  // When the owner hasn't configured STT there, a held key still summons — Cue
  // looks at the screen and answers the default question instead of hearing
  // one. Degraded and visible, not a silent dead end.
  const voiceReady = true;

  // The mock's status pill: "running · companion" when live. The shipped mode
  // is always Companion, so we surface that. We reflect the *real* run state.
  const pillRunning = status.enabled && status.running;
  const modeWord = status.takeControl ? "take-control" : "companion";
  const pillLabel = pillRunning
    ? `running · ${modeWord}`
    : status.enabled
      ? `idle · ${modeWord}`
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
            data-coach="cuelive-enable"
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

        {/* Blocking permissions onboarding — shown whenever a grant is missing
            (and Cue Live is enabled). The single most important "it doesn't
            work" unblock: deep-links to the right System Settings pane. */}
        {status.enabled && (
          <PermissionsBanner permissions={effectivePermissions} />
        )}

        <ModeCards
          takeControlOn={status.takeControl}
          busy={busy}
          onSelectTakeControl={(next) => void handleTakeControl(next)}
        />

        {/* Hotkeys + Voice bindings */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 18,
          }}
        >
          <HotkeysCard
            summonHotkey={status.hotkey}
            voiceReady={voiceReady}
            onStop={handleStop}
          />
          <VoiceBindingsCard
            voiceId={voiceKeys?.elevenLabsVoiceId ?? null}
            onChange={openVoiceSetup}
          />
        </div>

        <AutoRunGoals />

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
        {showVoiceSetup && voiceKeys && <VoiceSetup />}
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
          blockedReason={
            !effectivePermissions.screenRecordingGranted
              ? "Needs Screen Recording — grant it above and this switches on."
              : !effectivePermissions.accessibilityTrusted
                ? "Needs Accessibility — grant it above and this switches on."
                : null
          }
        />
        <HowItSeesCard />
        <TrustNote />
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Off-desktop — the explainer (frame L1), which hands over to the remote     */
/* viewer (mobile-v3 frame 52) the moment a session is live. Capture stays on */
/* the Mac; away from it this page states where control lives and how to turn */
/* it on, instead of a bare viewer that looks broken when nothing is running. */
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
        {available ? <DesktopControlPanel /> : <CueLiveWebExplainer />}
      </div>
    </>
  );
}
