/**
 * Mv3AutonomyStep — onboarding Step 3, mobile v3 (spec frame 27): "How much
 * should Cue do on its own?" as three honest cards (Observe / Assist /
 * Autonomous · RECOMMENDED), with the AUTO/ASK taxonomy chips + the receipts
 * promise on the recommended card.
 *
 * Wiring: the pick targets the SAME setting the HQ/You mode dial writes —
 * `workspaceMode` on `PUT /company-profile`. The funnel may run before a
 * daemon is reachable, so Continue parks the pick as a pending value
 * (mv3-onboarding-prefs); root-layout applies it the moment an assistant is
 * active. The step is skippable (no write at all on Skip).
 */
import { useState } from "react";

import { haptic } from "@/utils/haptics";

import {
  writePendingWorkspaceMode,
  type PendingWorkspaceMode,
} from "../../mv3-onboarding-prefs";
import { Mv3OnboardingShell } from "./mv3-onboarding-shell";

const CARD_META: Array<{
  id: PendingWorkspaceMode;
  label: string;
  blurb: string;
  recommended?: boolean;
}> = [
  {
    id: "observe",
    label: "Observe",
    blurb: "Watches & suggests. Touches nothing.",
  },
  {
    id: "assist",
    label: "Assist",
    blurb: "Drafts everything. You send everything.",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    blurb: "Runs research & drafts alone. Asks before anything leaves or costs.",
    recommended: true,
  },
];

const TAXONOMY_CHIPS: Array<{ label: string; tone: "green" | "amber" }> = [
  { label: "RESEARCH AUTO", tone: "green" },
  { label: "SEND ASKS", tone: "amber" },
  { label: "SPEND ASKS", tone: "amber" },
];

export function Mv3AutonomyStep({
  onContinue,
  onSkip,
}: {
  /** Receives the picked mode so the flow can apply it live when possible. */
  onContinue: (mode: PendingWorkspaceMode) => void;
  onSkip: () => void;
}) {
  const [mode, setMode] = useState<PendingWorkspaceMode>("autonomous");

  return (
    <Mv3OnboardingShell
      step="Step 3 of 4"
      onSkip={onSkip}
      cta="Continue"
      onCta={() => {
        writePendingWorkspaceMode(mode);
        onContinue(mode);
      }}
    >
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: "-0.7px",
          lineHeight: 1.15,
        }}
      >
        How much should
        <br />
        Cue do on its own?
      </div>
      <div style={{ fontSize: 14, color: "var(--mv3-muted)", marginTop: 8 }}>
        You can change this anytime — per project, even per task.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
        {CARD_META.map((card) => {
          const active = card.id === mode;
          return (
            <button
              key={card.id}
              type="button"
              className="cue-pressable"
              aria-pressed={active}
              onClick={() => {
                haptic.light();
                setMode(card.id);
              }}
              style={{
                textAlign: "left",
                fontFamily: "inherit",
                background: active
                  ? "color-mix(in srgb, var(--mv3-accent) 12%, var(--mv3-card))"
                  : "var(--mv3-card)",
                border: active
                  ? "1.5px solid var(--mv3-accent)"
                  : "1px solid var(--mv3-card-border)",
                borderRadius: 20,
                padding: "15px 16px",
                cursor: "pointer",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                boxShadow: active
                  ? "0 20px 44px -18px color-mix(in srgb, var(--mv3-accent) 50%, transparent)"
                  : "var(--mv3-card-shadow)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "var(--mv3-text)" }}>
                    {card.label}
                    {card.recommended ? (
                      <span
                        style={{
                          fontSize: 10,
                          color: "var(--mv3-micro)",
                          background:
                            "color-mix(in srgb, var(--mv3-accent) 20%, transparent)",
                          borderRadius: 6,
                          padding: "2px 7px",
                          marginLeft: 6,
                          verticalAlign: 2,
                          fontFamily: "var(--mv3-mono)",
                          letterSpacing: "0.06em",
                        }}
                      >
                        RECOMMENDED
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--mv3-muted)", marginTop: 3 }}>
                    {card.blurb}
                  </div>
                </div>
                <span
                  aria-hidden
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    flexShrink: 0,
                    border: active
                      ? "2px solid var(--mv3-accent)"
                      : "2px solid color-mix(in srgb, var(--mv3-muted) 40%, transparent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {active ? (
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--mv3-accent)",
                      }}
                    />
                  ) : null}
                </span>
              </div>

              {card.recommended ? (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginTop: 12,
                    paddingTop: 11,
                    borderTop: "1px solid var(--mv3-line)",
                    flexWrap: "wrap",
                  }}
                >
                  {TAXONOMY_CHIPS.map((chip) => (
                    <span
                      key={chip.label}
                      style={{
                        fontFamily: "var(--mv3-mono)",
                        fontSize: 9,
                        letterSpacing: "0.04em",
                        color:
                          chip.tone === "green"
                            ? "var(--mv3-green)"
                            : "var(--mv3-amber)",
                        background:
                          chip.tone === "green"
                            ? "color-mix(in srgb, var(--mv3-green) 12%, transparent)"
                            : "color-mix(in srgb, var(--mv3-amber) 12%, transparent)",
                        padding: "4px 8px",
                        borderRadius: 6,
                      }}
                    >
                      {chip.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </button>
          );
        })}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            justifyContent: "center",
            padding: "4px 0",
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--mv3-green)"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M12 2l7 4v6c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6z" />
          </svg>
          <span style={{ fontSize: 11.5, color: "var(--mv3-faint)" }}>
            Every autonomous act is logged — you&rsquo;ll see the receipts
          </span>
        </div>
      </div>
    </Mv3OnboardingShell>
  );
}
