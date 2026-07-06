/**
 * The Agents-org editors — the surfaces the ⋯ menu and the Hire card open.
 * All edits persist to the server-side agent registry via `useCharterActions`
 * (see `charters.ts`), so a re-charter or hire is shared across devices.
 *
 *  · CharterEditor — one modal covering Rename / Edit charter / Change tier /
 *    Set spend cap (the ⋯ menu actions collapse into a single edit sheet so a
 *    re-charter is one coherent act, not four dialogs). Pause toggles inline
 *    from the menu without opening this.
 *  · HireModal — "Add a role" — name, emoji, domain, charter, starting tier.
 *
 * The dark hero chrome + serif display + DM-Mono microlabels track the locked
 * Cue-HQ-Build voice; colors ride the theme-aware `C` tokens.
 */

import { useEffect, useState } from "react";

import { C, mono, serif } from "@/domains/activity/theme";

import {
  TIER_META,
  useCharterActions,
  type AgentCharter,
  type AgentTier,
} from "./charters";

/**
 * Close the sheet on Escape — both modals are hand-rolled dialogs (no
 * <dialog>/Radix), so backdrop-click was the only way out before this.
 */
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}

const EMOJI_CHOICES = ["⚙", "▲", "✦", "◆", "✎", "☉", "◉", "⬡", "✿", "⚑"];
const TIERS: AgentTier[] = [1, 2, 3, 4];

const overlayStyle = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 60,
  background: "color-mix(in srgb, #000 42%, transparent)",
  display: "grid",
  placeItems: "center",
  padding: 16,
};

const sheetStyle = {
  width: "min(480px, 100%)",
  maxHeight: "90vh",
  overflowY: "auto" as const,
  background: C.surface,
  border: `1px solid ${C.line2}`,
  borderRadius: 16,
  boxShadow: "0 24px 60px -20px rgba(0,0,0,0.5)",
  padding: "22px 22px 20px",
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: C.t3,
        marginBottom: 7,
      }}
    >
      {children}
    </div>
  );
}

function EmojiPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (e: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {EMOJI_CHOICES.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onChange(e)}
          aria-pressed={value === e}
          style={{
            fontSize: 16,
            width: 34,
            height: 34,
            borderRadius: 9,
            cursor: "pointer",
            border: `1px solid ${value === e ? C.blue : C.line}`,
            background: value === e ? C.blueW : C.surface,
            color: C.t1,
          }}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function TierPicker({
  value,
  onChange,
}: {
  value: AgentTier;
  onChange: (t: AgentTier) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {TIERS.map((t) => {
        const on = value === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            aria-pressed={on}
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 11,
              fontWeight: on ? 600 : 400,
              cursor: "pointer",
              color: on ? "#fff" : C.t3,
              background: on ? C.blue : C.surface,
              border: on ? "none" : `1px solid ${C.line}`,
              borderRadius: 8,
              padding: "8px 4px",
              boxShadow: on ? `0 6px 16px -8px ${C.blue}` : "none",
            }}
          >
            {TIER_META[t].dial}
          </button>
        );
      })}
    </div>
  );
}

// Fixed dark ink button (theme-constant like the You-node) — `C.ink` flips to
// white under dark theme, which would hide the white label.
const INK_BTN = "#1A2230";

function primaryBtn(disabled: boolean) {
  return {
    flex: 1,
    textAlign: "center" as const,
    fontSize: 12.5,
    fontWeight: 600,
    color: "#fff",
    background: INK_BTN,
    borderRadius: 10,
    padding: 11,
    border: "none",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

const ghostBtn = {
  fontSize: 12.5,
  background: C.sunken,
  color: C.t2,
  borderRadius: 10,
  padding: "11px 15px",
  border: "none",
  cursor: "pointer",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  fontSize: 13,
  color: C.t1,
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 10,
  padding: "10px 12px",
  fontFamily: "inherit",
};

// ---------------------------------------------------------------------------
// Charter editor — Rename / Edit charter / Change tier / Set spend cap.
// ---------------------------------------------------------------------------

export function CharterEditor({
  assistantId,
  charter,
  onClose,
}: {
  assistantId: string;
  charter: AgentCharter;
  onClose: () => void;
}) {
  const [name, setName] = useState(charter.name);
  const [emoji, setEmoji] = useState(charter.emoji);
  const [domain, setDomain] = useState(charter.domain);
  const [mandate, setMandate] = useState(charter.charter);
  const [tier, setTier] = useState<AgentTier>(charter.tier);
  const [cap, setCap] = useState<string>(
    charter.capUsd != null ? String(charter.capUsd) : "",
  );
  const { update } = useCharterActions(assistantId);
  useEscapeToClose(onClose);

  const canSave = name.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const parsedCap = Number(cap.trim());
    update(charter.id, {
      name: name.trim(),
      emoji,
      domain: domain.trim(),
      charter: mandate.trim(),
      tier,
      capUsd:
        cap.trim().length > 0 && Number.isFinite(parsedCap) && parsedCap > 0
          ? parsedCap
          : null,
    });
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${charter.name}`}
      onClick={onClose}
      style={overlayStyle}
    >
      <div onClick={(e) => e.stopPropagation()} style={sheetStyle}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Re-charter
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 25,
            letterSpacing: "-0.4px",
            color: C.ink,
            marginTop: 2,
            marginBottom: 18,
          }}
        >
          Reshape the role.
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div>
            <FieldLabel>Icon</FieldLabel>
            <div style={{ width: 232 }}>
              <EmojiPicker value={emoji} onChange={setEmoji} />
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Name</FieldLabel>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ops"
            style={inputStyle}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <FieldLabel>Domain</FieldLabel>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="Operations"
            style={inputStyle}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <FieldLabel>Charter — the standing mandate</FieldLabel>
          <textarea
            value={mandate}
            onChange={(e) => setMandate(e.target.value)}
            rows={2}
            placeholder="Keep the raise & ops moving — never let a thread go cold."
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.4 }}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Autonomy tier</FieldLabel>
          <TierPicker value={tier} onChange={setTier} />
        </div>

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Weekly spend cap (USD) — optional</FieldLabel>
          <input
            value={cap}
            inputMode="numeric"
            onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="No cap"
            style={inputStyle}
          />
        </div>

        <div style={{ display: "flex", gap: 9, marginTop: 20 }}>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            style={primaryBtn(!canSave)}
          >
            Save charter
          </button>
          <button type="button" onClick={onClose} style={ghostBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hire modal — add a role to the org.
// ---------------------------------------------------------------------------

export function HireModal({
  assistantId,
  onClose,
  onHired,
}: {
  assistantId: string;
  onClose: () => void;
  onHired: () => void;
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(EMOJI_CHOICES[3]);
  const [domain, setDomain] = useState("");
  const [mandate, setMandate] = useState("");
  const [tier, setTier] = useState<AgentTier>(2);
  const { hire: hireAgent } = useCharterActions(assistantId);
  useEscapeToClose(onClose);

  const canHire = name.trim().length > 0;

  const hire = () => {
    if (!canHire) return;
    hireAgent({
      name: name.trim(),
      emoji,
      domain: domain.trim(),
      charter: mandate.trim(),
      tier,
    });
    onHired();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Hire an agent"
      onClick={onClose}
      style={overlayStyle}
    >
      <div onClick={(e) => e.stopPropagation()} style={sheetStyle}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Hire an agent
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 25,
            letterSpacing: "-0.4px",
            color: C.ink,
            marginTop: 2,
            marginBottom: 4,
          }}
        >
          Add a role — not a tool.
        </div>
        <div style={{ fontSize: 12.5, color: C.t2, marginBottom: 18 }}>
          Finance, Support, Recruiting… give it a name and a mandate.
        </div>

        <FieldLabel>Icon</FieldLabel>
        <EmojiPicker value={emoji} onChange={setEmoji} />

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Name</FieldLabel>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Finance"
            autoFocus
            style={inputStyle}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <FieldLabel>Domain</FieldLabel>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="Finance & runway"
            style={inputStyle}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <FieldLabel>Charter — the standing mandate</FieldLabel>
          <textarea
            value={mandate}
            onChange={(e) => setMandate(e.target.value)}
            rows={2}
            placeholder="Watch the runway — flag anything that moves the burn."
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.4 }}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Starting tier</FieldLabel>
          <TierPicker value={tier} onChange={setTier} />
        </div>

        <div style={{ display: "flex", gap: 9, marginTop: 20 }}>
          <button
            type="button"
            onClick={hire}
            disabled={!canHire}
            style={primaryBtn(!canHire)}
          >
            Add to the org
          </button>
          <button type="button" onClick={onClose} style={ghostBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
