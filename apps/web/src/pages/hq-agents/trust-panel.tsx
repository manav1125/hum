/**
 * Agent-trust panel (Cue-HQ-Build State 5 · "opened from a tier chip").
 *
 * A per-agent sheet: the autonomy dial (which tier it's on), the static
 * may-do / always-asks lines derived from the tier, and the auditable track
 * record. Track record renders the honest "measuring…" treatment until the
 * acts-summary route answers (feature-detected upstream in `use-agent-data`).
 * "Grant more autonomy" and "Preferences" both route to the trust preferences
 * surface — this panel only reads; the leash is set there.
 */

import { C, mono } from "@/domains/activity/theme";

import {
  sinceLabel,
  TIER_META,
  type AgentCharter,
  type AgentTier,
} from "./charters";
import type { AgentActs } from "./use-agent-data";

const TIERS: AgentTier[] = [1, 2, 3, 4];

export function TrustPanel({
  charter,
  acts,
  measuring,
  now,
  onClose,
  onOpenPreferences,
}: {
  charter: AgentCharter;
  acts: AgentActs | null;
  measuring: boolean;
  now: number;
  onClose: () => void;
  onOpenPreferences: () => void;
}) {
  const meta = TIER_META[charter.tier];
  const since = sinceLabel(charter.hiredAt, now);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${charter.name} trust`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in srgb, #000 42%, transparent)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(452px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 18,
          boxShadow: "0 40px 90px -50px rgba(20,28,44,.4)",
          padding: 26,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              // Fixed dark tile (see agents-org-page TILE_BG) — C.ink flips
              // white in dark theme and would hide the glyph.
              background: "#1A2230",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 19,
              flexShrink: 0,
            }}
          >
            {charter.emoji}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.t1 }}>
              {charter.name}
            </div>
            <div style={{ fontSize: 12, color: C.t2 }}>
              {charter.domain ? `${charter.domain} agent` : "Your agent"}
              {since ? ` · ${since}` : ""}
            </div>
          </div>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              background: C.blueW,
              color: C.blueS,
              borderRadius: 7,
              padding: "5px 9px",
            }}
          >
            {meta.chip}
          </span>
        </div>

        {/* Autonomy dial */}
        <div
          style={{
            marginTop: 18,
            background: C.sunken,
            borderRadius: 14,
            padding: "15px 17px",
          }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: 9.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: C.t3,
              marginBottom: 11,
            }}
          >
            Autonomy
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {TIERS.map((t) => {
              const on = charter.tier === t;
              return (
                <div
                  key={t}
                  style={{
                    flex: 1,
                    textAlign: "center",
                    fontSize: 11,
                    fontWeight: on ? 600 : 400,
                    color: on ? "#fff" : C.t3,
                    background: on ? C.blue : C.surface,
                    border: on ? "none" : `1px solid ${C.line}`,
                    borderRadius: 8,
                    padding: "8px 4px",
                    boxShadow: on ? `0 6px 16px -8px ${C.blue}` : "none",
                  }}
                >
                  {TIER_META[t].dial}
                </div>
              );
            })}
          </div>
        </div>

        {/* May do on its own */}
        <div
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: C.t3,
            margin: "18px 0 8px",
          }}
        >
          May do on its own
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {meta.mayDo.map((line) => (
            <div
              key={line}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontSize: 12.5,
                color: C.t1,
              }}
            >
              <span style={{ color: C.green }}>✓</span> {line}
            </div>
          ))}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: 12.5,
              color: C.t1,
            }}
          >
            <span style={{ color: C.danger }}>✕</span> {meta.alwaysAsks}{" "}
            <span style={{ fontFamily: mono, fontSize: 10, color: C.t3 }}>
              · always asks
            </span>
          </div>
        </div>

        {/* Track record — honest until the acts ledger is real */}
        <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
          <div
            style={{
              flex: 1,
              background: C.surface,
              border: `1px solid ${C.line}`,
              borderRadius: 11,
              padding: "11px 13px",
            }}
          >
            <div style={{ fontFamily: mono, fontSize: 9.5, color: C.t3 }}>
              TRACK RECORD
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                marginTop: 2,
                color: C.t1,
              }}
            >
              {measuring || !acts ? (
                <span style={{ fontSize: 12, fontWeight: 400, color: C.t3 }}>
                  measuring…
                </span>
              ) : (
                <>
                  {acts.actions}{" "}
                  <span style={{ fontSize: 11, fontWeight: 400, color: C.t3 }}>
                    actions
                  </span>
                </>
              )}
            </div>
          </div>
          <div
            style={{
              flex: 1,
              background:
                measuring || !acts
                  ? C.sunken
                  : "color-mix(in srgb, var(--mv1-green) 12%, transparent)",
              border: `1px solid ${measuring || !acts ? C.line : "color-mix(in srgb, var(--mv1-green) 30%, transparent)"}`,
              borderRadius: 11,
              padding: "11px 13px",
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: 9.5,
                color: measuring || !acts ? C.t3 : C.green,
              }}
            >
              REVERSED BY YOU
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                marginTop: 2,
                color: measuring || !acts ? C.t3 : C.green,
              }}
            >
              {measuring || !acts ? (
                <span style={{ fontSize: 12, fontWeight: 400 }}>—</span>
              ) : (
                acts.reversed
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 9, paddingTop: 20 }}>
          <button
            type="button"
            onClick={onOpenPreferences}
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 12.5,
              fontWeight: 600,
              background: "#1A2230",
              color: "#fff",
              borderRadius: 10,
              padding: 11,
              border: "none",
              cursor: "pointer",
            }}
          >
            Grant more autonomy
          </button>
          <button
            type="button"
            onClick={onOpenPreferences}
            style={{
              textAlign: "center",
              fontSize: 12.5,
              background: C.sunken,
              color: C.t2,
              borderRadius: 10,
              padding: "11px 15px",
              border: "none",
              cursor: "pointer",
            }}
          >
            Preferences
          </button>
        </div>
      </div>
    </div>
  );
}
