/**
 * Mv3WelcomeStep — onboarding Step 1, mobile v3 (spec frame 26): the ring
 * carries over from sign-on, "Let's set up your Cue.", one name field
 * (prefilled from the account) and the scope chip row (Founder / Founder +
 * personal / Just life → persisted via mv3-onboarding-prefs).
 *
 * Mobile restyle of the funnel's existing "name" step: same `userName` state
 * and advance/skip callbacks as NameExchangeScreen; the assistant keeps its
 * sampled default name (the step stays skippable, nothing new is required).
 */
import { useState } from "react";

import { CueRing } from "@/mobile-v3/cue-ring";
import { haptic } from "@/utils/haptics";

import {
  ONBOARDING_SCOPES,
  readOnboardingScope,
  writeOnboardingScope,
  type OnboardingScope,
} from "../../mv3-onboarding-prefs";
import { Mv3OnboardingShell } from "./mv3-onboarding-shell";

export function Mv3WelcomeStep({
  userName,
  onUserNameChange,
  onContinue,
}: {
  userName: string;
  onUserNameChange: (value: string) => void;
  onContinue: () => void;
}) {
  const [scope, setScope] = useState<OnboardingScope>(
    () => readOnboardingScope() ?? "founder-personal",
  );

  return (
    <Mv3OnboardingShell
      step="Step 1 of 4"
      cta="Continue"
      onCta={() => {
        writeOnboardingScope(scope);
        onContinue();
      }}
      centered
    >
      <div style={{ position: "relative", width: 90, height: 90, animation: "mv3Rise .8s ease both" }}>
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: -20,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, var(--mv3-ring-glow), transparent 62%)",
            filter: "blur(16px)",
            animation: "mv3Glow 4s ease-in-out infinite",
          }}
        />
        <CueRing size={90} stroke="var(--mv3-text)" style={{ position: "relative" }} />
      </div>

      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: "-0.8px",
          lineHeight: 1.14,
          marginTop: 26,
          animation: "mv3Rise .8s ease .15s both",
        }}
      >
        Let&rsquo;s set up
        <br />
        your Cue.
      </div>
      <div
        style={{
          fontSize: 15,
          color: "var(--mv3-muted)",
          marginTop: 10,
          lineHeight: 1.55,
          animation: "mv3Rise .8s ease .3s both",
        }}
      >
        Four quick steps. It learns from here —<br />
        every answer makes it more yours.
      </div>

      <div style={{ marginTop: 30, animation: "mv3Rise .8s ease .45s both" }}>
        <div
          style={{
            fontSize: 12.5,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--mv3-muted)",
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          What should Cue call you?
        </div>
        <input
          value={userName}
          onChange={(e) => onUserNameChange(e.target.value)}
          placeholder="Your name"
          aria-label="What should Cue call you?"
          style={{
            width: "100%",
            fontSize: 16,
            padding: "15px 16px",
            background: "var(--mv3-card)",
            border: "1.5px solid var(--mv3-accent)",
            borderRadius: 16,
            boxShadow:
              "0 0 0 4px color-mix(in srgb, var(--mv3-accent) 15%, transparent)",
            color: "var(--mv3-text)",
            outline: "none",
            fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {ONBOARDING_SCOPES.map((s) => {
            const active = s.id === scope;
            return (
              <button
                key={s.id}
                type="button"
                className="cue-pressable"
                aria-pressed={active}
                onClick={() => {
                  haptic.light();
                  setScope(s.id);
                }}
                style={{
                  fontSize: 12.5,
                  fontFamily: "inherit",
                  borderRadius: 99,
                  padding: "8px 14px",
                  minHeight: 36,
                  cursor: "pointer",
                  ...(active
                    ? {
                        color: "var(--mv3-bg)",
                        background: "var(--mv3-text)",
                        border: "1px solid var(--mv3-text)",
                        fontWeight: 600,
                      }
                    : {
                        color: "var(--mv3-muted)",
                        background: "var(--mv3-btn2-bg)",
                        border: "1px solid var(--mv3-btn2-border)",
                      }),
                }}
              >
                {s.label}
                {active ? " ✓" : ""}
              </button>
            );
          })}
        </div>
      </div>
    </Mv3OnboardingShell>
  );
}
