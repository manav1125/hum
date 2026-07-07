/**
 * "How Cue thinks" — the optional onboarding-v2 step between name and
 * connect. Three cards:
 *
 *   · Cue credits (default, recommended) — the managed inference route;
 *     nothing to configure, continue and go.
 *   · Bring your own OpenRouter key — input → cheap validation against
 *     OpenRouter's key-introspection endpoint → stored via the daemon's
 *     EXISTING secrets path (`POST /v1/secrets {type:"api_key",
 *     name:"openrouter"}` → `credential/openrouter/api_key`, the credential
 *     the canonical `openrouter` provider connection already resolves).
 *   · "Use your Claude subscription" — a disabled visual placeholder
 *     (coming soon).
 *
 * Fully skippable, like every other step.
 */

import { useState } from "react";

import { C, mono } from "@/domains/activity/theme";

import {
  checkDotStyle,
  inputStyle,
  rowIconStyle,
  selectRowStyle,
  StepCard,
  StepFooter,
  StepHead,
} from "./setup-chrome";
import { useSaveOpenRouterKey, validateOpenRouterKey } from "./use-setup-data";

type ThinkChoice = "credits" | "byo" | "claude";

const OPTIONS: Array<{
  key: ThinkChoice;
  icon: string;
  title: string;
  sub: string;
  badge?: string;
  disabled?: boolean;
}> = [
  {
    key: "credits",
    icon: "✦",
    title: "Cue credits",
    sub: "Managed models, zero setup — just works",
    badge: "RECOMMENDED",
  },
  {
    key: "byo",
    icon: "🔑",
    title: "Bring your own OpenRouter key",
    sub: "Run Cue on your own OpenRouter account",
  },
  {
    key: "claude",
    icon: "◈",
    title: "Use your Claude subscription",
    sub: "Point Cue at your existing Claude plan",
    badge: "COMING SOON",
    disabled: true,
  },
];

type KeyPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "invalid" }
  | { kind: "network" }
  | { kind: "store_failed"; message: string };

export function ThinkStep({
  assistantId,
  stepNo,
  total,
  personal,
  onContinue,
  onSkip,
}: {
  assistantId: string;
  stepNo: number;
  total: number;
  personal: boolean;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [choice, setChoice] = useState<ThinkChoice>("credits");
  const [key, setKey] = useState("");
  const [phase, setPhase] = useState<KeyPhase>({ kind: "idle" });
  const save = useSaveOpenRouterKey();

  const submit = async () => {
    if (choice !== "byo") {
      onContinue();
      return;
    }
    const trimmed = key.trim();
    if (trimmed.length === 0) return;
    setPhase({ kind: "checking" });
    const check = await validateOpenRouterKey(trimmed);
    if (!check.ok) {
      setPhase({ kind: check.reason === "network" ? "network" : "invalid" });
      return;
    }
    save.mutate(
      {
        path: { assistant_id: assistantId },
        body: { type: "api_key", name: "openrouter", value: trimmed },
      },
      {
        onSuccess: (data) => {
          // The daemon reports validation-style failures in-band.
          if ((data as { success?: boolean }).success === false) {
            setPhase({
              kind: "store_failed",
              message:
                (data as { error?: string }).error ??
                "The key couldn't be saved — try again.",
            });
            return;
          }
          onContinue();
        },
        onError: () =>
          setPhase({
            kind: "store_failed",
            message:
              "Couldn't reach your instance to save the key — it stays on this screen, try again.",
          }),
      },
    );
  };

  const byoIncomplete = choice === "byo" && key.trim().length === 0;
  const busy = phase.kind === "checking" || save.isPending;

  return (
    <StepCard>
      <StepHead
        label={
          personal
            ? `Step ${stepNo} of ${total} · Personal`
            : `Step ${stepNo} / ${total}`
        }
        title="How should Cue think?"
        blurb="Pick the brain behind your assistant. You can change this any time in Settings."
      />

      <div
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
        data-slot="hq-setup-think-options"
      >
        {OPTIONS.map((opt) => {
          const on = choice === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              disabled={opt.disabled}
              onClick={() => {
                if (!opt.disabled) {
                  setChoice(opt.key);
                  setPhase({ kind: "idle" });
                }
              }}
              aria-pressed={on}
              data-slot={`hq-setup-think-${opt.key}`}
              style={{
                ...selectRowStyle,
                borderColor: on ? C.blue : C.line,
                background: on ? C.blueW : C.surface,
                boxShadow: on ? `inset 0 0 0 1px ${C.blue}` : "none",
                opacity: opt.disabled ? 0.55 : 1,
                cursor: opt.disabled ? "default" : "pointer",
              }}
            >
              <span style={rowIconStyle} aria-hidden>
                {opt.icon}
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 14.5,
                    fontWeight: 600,
                    color: C.t1,
                  }}
                >
                  {opt.title}
                  {opt.badge ? (
                    <span
                      style={{
                        fontFamily: mono,
                        fontSize: 9,
                        letterSpacing: "0.08em",
                        color: opt.disabled ? C.t3 : C.green,
                        border: `1px solid ${opt.disabled ? C.line2 : "var(--mv1-green)"}`,
                        borderRadius: 999,
                        padding: "2px 7px",
                        flexShrink: 0,
                      }}
                    >
                      {opt.badge}
                    </span>
                  ) : null}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: C.t2,
                    marginTop: 1,
                  }}
                >
                  {opt.sub}
                </span>
              </span>
              <span
                aria-hidden
                style={{
                  ...checkDotStyle,
                  borderColor: on ? C.blue : C.line2,
                  background: on ? C.blue : "transparent",
                  color: on ? "#fff" : "transparent",
                }}
              >
                ✓
              </span>
            </button>
          );
        })}
      </div>

      {choice === "byo" ? (
        <div style={{ marginTop: 12 }} data-slot="hq-setup-think-byo-form">
          <input
            value={key}
            autoFocus
            onChange={(e) => {
              setKey(e.target.value);
              setPhase({ kind: "idle" });
            }}
            placeholder="sk-or-v1-…"
            spellCheck={false}
            autoComplete="off"
            aria-label="OpenRouter API key"
            style={{ ...inputStyle, fontFamily: mono, fontSize: 13 }}
          />
          <div
            data-slot="hq-setup-think-byo-status"
            style={{
              fontFamily: mono,
              fontSize: 11,
              marginTop: 8,
              letterSpacing: "0.02em",
              color:
                phase.kind === "idle" || phase.kind === "checking"
                  ? C.t3
                  : C.danger,
            }}
          >
            {phase.kind === "checking"
              ? "Checking your key with OpenRouter…"
              : phase.kind === "invalid"
                ? "That key didn't validate with OpenRouter — check it and try again."
                : phase.kind === "network"
                  ? "Couldn't reach OpenRouter to validate — check your connection and try again."
                  : phase.kind === "store_failed"
                    ? phase.message
                    : "Validated with a quick OpenRouter check, then stored securely on your instance."}
          </div>
        </div>
      ) : null}

      <StepFooter
        continueLabel={
          busy
            ? "Checking…"
            : choice === "byo"
              ? "Validate & continue ›"
              : "Continue ›"
        }
        continueDisabled={byoIncomplete || busy}
        onContinue={() => void submit()}
        onSkip={onSkip}
        caption={
          choice === "credits"
            ? "Cue credits are metered to your plan — no keys to manage."
            : undefined
        }
      />
    </StepCard>
  );
}
