/**
 * Mv3RulesPage — the mobile Rules screen (spec frame 20: what Cue may do
 * alone + make-a-rule). Rendered by the Guardrails route's mobile branch;
 * desktop Guardrails is untouched.
 *
 * Three real rule stores, one surface (frame 20's row grammar throughout):
 *  · WHAT CUE MAY DO ALONE — the gateway per-category autonomy policies
 *    (research/draft/send/money/delete/other × auto/ask/never). Tapping a row
 *    opens the mode sheet (AUTO / ASK FIRST / NEVER, current state checked);
 *    picking one persists — the SAME store Settings → Privacy edits — and an
 *    undo toast restores the previous mode.
 *  · STANDING RULES — the trust-rules store (`trust/rules`): the auto-confirm
 *    rules you made ("Auto-confirm from Rachel"). Chip toggles `enabled`.
 *  · CHECKPOINTS — guardrails checkpoints ("Cue always asks before…"),
 *    chip toggles `enabled`; unenforced ones carry the honest ADVISORY tag.
 *
 * The "Always do this?" make-a-rule sheet (SheetShell) POSTs a real trust
 * rule (sender- or channel-triggered auto-confirm). The in-context trigger
 * ("you just confirmed a commitment from …") already exists in chat's
 * approval card; the demo entry point here is the header "+ Rule".
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  guardrailsCheckpointsByIdPatchMutation,
  trustRulesByIdPatchMutation,
  trustRulesGetQueryKey,
  trustRulesPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  AUTONOMY_CATEGORIES,
  type AutonomyCategory,
  type AutonomyMode,
} from "@/lib/autonomy-policies-api";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { SheetShell } from "../sheet-shell";
import { UndoToast, type Mv3Toast } from "../undo-toast";
import { microLabel, rise } from "../mv3-kit";
import { Eyebrow, YouScreen } from "./you-kit";
import {
  useAutonomyDial,
  useGuardrails,
  useStandingRules,
  type GuardrailsPayload,
  type StandingRule,
} from "./use-you-data";

type Checkpoint = GuardrailsPayload["checkpoints"][number];

/** Frame-20 row copy per category (icon, name, per-mode behavior line). */
const CATEGORY_ROW: Record<
  AutonomyCategory,
  { glyph: string; name: string }
> = {
  research: { glyph: "⌕", name: "Research" },
  draft: { glyph: "✎", name: "Drafting" },
  send: { glyph: "✉", name: "Sending anything external" },
  money: { glyph: "$", name: "Spending" },
  delete: { glyph: "⌫", name: "Deleting" },
  other: { glyph: "◦", name: "Everything else" },
};

const MODE_LINE: Record<AutonomyMode, string> = {
  auto: "Runs automatically",
  ask: "Always asks first",
  never: "Always declined",
};

/** Sheet copy per mode — the one-line explanation under each option. */
const MODE_OPTIONS: ReadonlyArray<{
  mode: AutonomyMode;
  label: string;
  line: string;
}> = [
  {
    mode: "auto",
    label: "AUTO",
    line: "Cue runs these on its own — you see them in the ledger",
  },
  {
    mode: "ask",
    label: "ASK FIRST",
    line: "Cue holds each one for your OK before acting",
  },
  {
    mode: "never",
    label: "NEVER",
    line: "Cue declines these outright — nothing runs",
  },
];

const MODE_WORD: Record<AutonomyMode, string> = {
  auto: "Auto",
  ask: "Ask first",
  never: "Never",
};

function ModeChip({ mode }: { mode: AutonomyMode }) {
  const color =
    mode === "auto"
      ? "var(--mv3-green)"
      : mode === "ask"
        ? "var(--mv3-amber)"
        : "var(--mv3-muted)";
  return (
    <span
      style={{
        ...microLabel,
        fontSize: 9.5,
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        padding: "4px 9px",
        borderRadius: 6,
      }}
    >
      {mode === "auto" ? "AUTO" : mode === "ask" ? "ASK" : "NEVER"}
    </span>
  );
}

function RuleRow({
  glyph,
  glyphColor,
  name,
  line,
  chip,
  isLast,
  onPress,
  /** Accessible name — falls back to the visible name (a11y: UAT polish). */
  ariaLabel,
}: {
  glyph: string;
  glyphColor: string;
  name: string;
  line: React.ReactNode;
  chip: React.ReactNode;
  isLast?: boolean;
  onPress?: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? name}
      disabled={!onPress}
      onClick={() => {
        if (!onPress) return;
        haptic.light();
        onPress();
      }}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "13px 15px",
        minHeight: 52,
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: isLast ? "none" : "1px solid var(--mv3-line)",
        cursor: onPress ? "pointer" : "default",
        fontFamily: "inherit",
        color: "var(--mv3-text)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: `color-mix(in srgb, ${glyphColor} 15%, transparent)`,
          color: glyphColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        {glyph}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>
          {name}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 11,
            color: "var(--mv3-muted)",
            marginTop: 1,
          }}
        >
          {line}
        </span>
      </span>
      {chip}
    </button>
  );
}

/**
 * The category state sheet (UAT P1: a bare tap used to cycle AUTO→ASK→NEVER
 * silently). Tap now opens this sheet — the three modes with one-line
 * explanations, current state checked; picking one persists and the caller
 * shows an undo toast.
 */
function ModeSheet({
  category,
  current,
  onPick,
  onClose,
}: {
  category: AutonomyCategory | null;
  current: AutonomyMode | null;
  onPick: (mode: AutonomyMode) => void;
  onClose: () => void;
}) {
  const row = category ? CATEGORY_ROW[category] : null;
  return (
    <SheetShell
      open={category !== null}
      onClose={onClose}
      label={row ? `${row.name} — when Cue may act` : "When Cue may act"}
    >
      {row ? (
        <div style={{ padding: "2px 2px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span
              aria-hidden
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: "var(--mv3-btn2-bg)",
                color: "var(--mv3-text)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
              }}
            >
              {row.glyph}
            </span>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{row.name}</span>
          </div>
          <div
            role="radiogroup"
            aria-label={`${row.name} mode`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 14,
            }}
          >
            {MODE_OPTIONS.map((opt) => {
              const active = current === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={`${opt.label} — ${opt.line}`}
                  onClick={() => {
                    haptic.light();
                    onPick(opt.mode);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    width: "100%",
                    textAlign: "left",
                    border: active
                      ? "1.5px solid var(--mv3-accent)"
                      : "1px solid var(--mv3-btn2-border)",
                    borderRadius: 13,
                    padding: "12px 13px",
                    minHeight: 56,
                    background: active ? "rgba(61,110,232,.1)" : "transparent",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    color: "var(--mv3-text)",
                  }}
                >
                  <ModeChip mode={opt.mode} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 12,
                        color: "var(--mv3-muted)",
                        lineHeight: 1.45,
                      }}
                    >
                      {opt.line}
                    </span>
                  </span>
                  {active ? (
                    <span
                      aria-hidden
                      style={{ color: "var(--mv3-accent)", fontSize: 14 }}
                    >
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </SheetShell>
  );
}

/** The "Always do this?" make-a-rule sheet — POSTs a real trust rule. */
function MakeRuleSheetV3({
  assistantId,
  open,
  onClose,
}: {
  assistantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [trigger, setTrigger] = useState<"sender" | "channel">("sender");
  const [value, setValue] = useState("");

  const create = useMutation({
    ...trustRulesPostMutation(),
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({
        queryKey: trustRulesGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
      setValue("");
      onClose();
    },
  });

  const canSave = value.trim().length > 0 && !create.isPending;

  const option = (
    kind: "sender" | "channel",
    label: string,
  ): React.ReactNode => {
    const active = trigger === kind;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => {
          haptic.light();
          setTrigger(kind);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          textAlign: "left",
          border: active
            ? "1.5px solid var(--mv3-accent)"
            : "1px solid var(--mv3-btn2-border)",
          borderRadius: 13,
          padding: "11px 13px",
          minHeight: 44,
          background: active ? "rgba(61,110,232,.1)" : "transparent",
          cursor: "pointer",
          fontFamily: "inherit",
          color: active ? "var(--mv3-text)" : "var(--mv3-muted)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 17,
            height: 17,
            borderRadius: "50%",
            border: active
              ? "2px solid var(--mv3-accent)"
              : "2px solid var(--mv3-btn2-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
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
        <span style={{ fontSize: 13 }}>{label}</span>
      </button>
    );
  };

  return (
    <SheetShell open={open} onClose={onClose} label="Make a rule">
      <div style={{ padding: "2px 2px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            aria-hidden
            style={{
              width: 24,
              height: 24,
              borderRadius: 8,
              background: "var(--mv3-accent-fill)",
              color: "var(--mv3-accent-on-fill)",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ↴
          </span>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Always do this?</span>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--mv3-muted)",
            marginTop: 8,
            lineHeight: 1.5,
          }}
        >
          Cue auto-confirms matching items instead of holding them for you.
        </div>

        <div
          role="radiogroup"
          aria-label="Rule trigger"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 12,
          }}
        >
          {option("sender", "Auto-confirm from one sender")}
          {option("channel", "Auto-confirm anything from a channel")}
        </div>

        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            trigger === "sender" ? "Who? e.g. Rachel" : "Which channel? e.g. slack"
          }
          aria-label={trigger === "sender" ? "Sender name" : "Channel name"}
          style={{
            width: "100%",
            fontSize: 16,
            fontFamily: "inherit",
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 12,
            padding: "12px 14px",
            minHeight: 44,
            outline: "none",
            marginTop: 12,
          }}
        />

        {create.isError ? (
          <div style={{ fontSize: 12, color: "#E5675B", marginTop: 8 }}>
            Couldn't save the rule — try again.
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => {
              haptic.medium();
              create.mutate({
                path: { assistant_id: assistantId },
                body: {
                  triggerType: trigger,
                  triggerValue: value.trim(),
                  action: "auto_confirm",
                },
              });
            }}
            style={{
              flex: 1,
              fontSize: 13.5,
              fontWeight: 600,
              fontFamily: "inherit",
              background: "var(--mv3-text)",
              color: "var(--mv3-bg)",
              border: "none",
              borderRadius: 12,
              padding: 12,
              minHeight: 44,
              cursor: canSave ? "pointer" : "default",
              opacity: canSave ? 1 : 0.55,
            }}
          >
            {create.isPending ? "Saving…" : "Make it a rule"}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 13.5,
              fontFamily: "inherit",
              background: "var(--mv3-btn2-bg)",
              color: "var(--mv3-muted)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 12,
              padding: "12px 16px",
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            Not now
          </button>
        </div>
      </div>
    </SheetShell>
  );
}

export function Mv3RulesPage() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const { policies, setCategory } = useAutonomyDial(assistantId);
  const guardrails = useGuardrails(assistantId);
  const { rules } = useStandingRules(assistantId);
  const [sheetOpen, setSheetOpen] = useState(false);
  // The category whose state sheet is open (UAT P1: no more tap-to-cycle).
  const [modeSheetFor, setModeSheetFor] = useState<AutonomyCategory | null>(
    null,
  );
  const [toast, setToast] = useState<Mv3Toast | null>(null);

  const checkpoints: Checkpoint[] = guardrails.data?.checkpoints ?? [];
  // Header count = enabled rows only (UAT: the count must match what's on).
  const enabledRuleCount =
    rules.filter((r) => r.enabled === 1).length +
    checkpoints.filter((c) => c.enabled === 1).length;
  const totalRuleCount = rules.length + checkpoints.length;

  const pickMode = (category: AutonomyCategory, next: AutonomyMode) => {
    const previous = policies?.[category] ?? null;
    setModeSheetFor(null);
    if (previous === next) return;
    setCategory.mutate({ category, mode: next });
    setToast({
      key: Date.now(),
      message: `${CATEGORY_ROW[category].name} → ${MODE_WORD[next]}`,
      actionLabel: previous ? "Undo" : undefined,
      onAction: previous
        ? () => {
            haptic.light();
            setCategory.mutate({ category, mode: previous });
          }
        : undefined,
    });
  };

  const patchRule = useMutation({
    ...trustRulesByIdPatchMutation(),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: trustRulesGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    },
  });
  const patchCheckpoint = useMutation({
    ...guardrailsCheckpointsByIdPatchMutation(),
    onSettled: () => {
      void queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          (q.queryKey[0] as { _id?: string })?._id === "guardrailsGet",
      });
    },
  });

  const ruleLine = (rule: StandingRule): string => {
    switch (rule.triggerType) {
      case "sender":
        return `Anything from ${rule.triggerValue} confirms itself`;
      case "channel":
        return `Anything arriving on ${rule.triggerValue}`;
      case "category":
        return `${rule.triggerValue} actions confirm themselves`;
      default:
        return `Tool ${rule.triggerValue}`;
    }
  };

  return (
    <YouScreen
      tint="blue"
      testId="mv3-rules"
      back={routes.channels}
      trailing={
        <button
          type="button"
          onClick={() => {
            haptic.light();
            setSheetOpen(true);
          }}
          style={{
            fontSize: 13,
            color: "var(--mv3-micro)",
            background: "none",
            border: "none",
            padding: "6px 0",
            minHeight: 44,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          + Rule
        </button>
      }
      title="Rules"
      sub={
        guardrails.isLoading
          ? "Reading your rules…"
          : `${enabledRuleCount} of ${totalRuleCount} standing rule${totalRuleCount === 1 ? "" : "s"} on · every one listed, none hidden`
      }
    >
      {/* Per-category autonomy defaults. */}
      <GlassCard padding={0} radius={20} style={{ overflow: "hidden", ...rise(0.1) }}>
        {AUTONOMY_CATEGORIES.map((category, i) => {
          const row = CATEGORY_ROW[category];
          const mode = policies?.[category] ?? null;
          return (
            <RuleRow
              key={category}
              glyph={row.glyph}
              glyphColor={
                mode === "auto"
                  ? "var(--mv3-green)"
                  : mode === "never"
                    ? "var(--mv3-dim-glyph)"
                    : "var(--mv3-amber)"
              }
              name={row.name}
              ariaLabel={
                mode
                  ? `${row.name} — ${MODE_WORD[mode]}. Change when Cue may act`
                  : row.name
              }
              line={mode ? MODE_LINE[mode] : "Loading…"}
              chip={mode ? <ModeChip mode={mode} /> : null}
              isLast={i === AUTONOMY_CATEGORIES.length - 1}
              onPress={mode ? () => setModeSheetFor(category) : undefined}
            />
          );
        })}
      </GlassCard>

      {/* Standing auto-confirm rules you made. */}
      {rules.length > 0 ? (
        <div style={{ ...rise(0.25) }}>
          <div style={{ padding: "4px 4px 8px" }}>
            <Eyebrow>Standing rules</Eyebrow>
          </div>
          <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
            {rules.map((rule, i) => {
              const on = rule.enabled === 1;
              return (
                <RuleRow
                  key={rule.id}
                  glyph="↴"
                  glyphColor={on ? "var(--mv3-green)" : "var(--mv3-dim-glyph)"}
                  name={rule.label}
                  ariaLabel={`${rule.label} — ${on ? "on" : "off"}. ${
                    on ? "Switch off" : "Switch on"
                  }`}
                  line={ruleLine(rule)}
                  chip={<span
                    style={{
                      ...microLabel,
                      fontSize: 9.5,
                      color: on ? "var(--mv3-green)" : "var(--mv3-muted)",
                      background: `color-mix(in srgb, ${
                        on ? "var(--mv3-green)" : "var(--mv3-muted)"
                      } 12%, transparent)`,
                      padding: "4px 9px",
                      borderRadius: 6,
                    }}
                  >
                    {on ? "AUTO" : "OFF"}
                  </span>}
                  isLast={i === rules.length - 1}
                  onPress={() => {
                    patchRule.mutate({
                      path: { assistant_id: assistantId, id: rule.id },
                      body: { enabled: !on },
                    });
                    setToast({
                      key: Date.now(),
                      message: `${rule.label} → ${on ? "off" : "on"}`,
                      actionLabel: "Undo",
                      onAction: () => {
                        haptic.light();
                        patchRule.mutate({
                          path: { assistant_id: assistantId, id: rule.id },
                          body: { enabled: on },
                        });
                      },
                    });
                  }}
                />
              );
            })}
          </GlassCard>
        </div>
      ) : null}

      {/* Checkpoints — "Cue always asks before…". */}
      {checkpoints.length > 0 ? (
        <div style={{ ...rise(0.4) }}>
          <div style={{ padding: "4px 4px 8px" }}>
            <Eyebrow>Checkpoints · always asks before</Eyebrow>
          </div>
          <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
            {checkpoints.map((cp, i) => {
              const on = cp.enabled === 1;
              return (
                <RuleRow
                  key={cp.id}
                  glyph="‖"
                  glyphColor={on ? "var(--mv3-amber)" : "var(--mv3-dim-glyph)"}
                  name={cp.label}
                  ariaLabel={`Checkpoint: ${cp.label} — ${on ? "on" : "off"}. ${
                    on ? "Switch off" : "Switch on"
                  }`}
                  line={
                    on
                      ? cp.enforced
                        ? "Always asks first"
                        : "Always asks first · advisory"
                      : "Off"
                  }
                  chip={<span
                    style={{
                      ...microLabel,
                      fontSize: 9.5,
                      color: on ? "var(--mv3-amber)" : "var(--mv3-muted)",
                      background: `color-mix(in srgb, ${
                        on ? "var(--mv3-amber)" : "var(--mv3-muted)"
                      } 12%, transparent)`,
                      padding: "4px 9px",
                      borderRadius: 6,
                    }}
                  >
                    {on ? "ASK" : "OFF"}
                  </span>}
                  isLast={i === checkpoints.length - 1}
                  onPress={() => {
                    patchCheckpoint.mutate({
                      path: { assistant_id: assistantId, id: cp.id },
                      body: { enabled: !on },
                    });
                    setToast({
                      key: Date.now(),
                      message: `${cp.label} → ${on ? "off" : "on"}`,
                      actionLabel: "Undo",
                      onAction: () => {
                        haptic.light();
                        patchCheckpoint.mutate({
                          path: { assistant_id: assistantId, id: cp.id },
                          body: { enabled: on },
                        });
                      },
                    });
                  }}
                />
              );
            })}
          </GlassCard>
        </div>
      ) : null}

      <ModeSheet
        category={modeSheetFor}
        current={modeSheetFor ? (policies?.[modeSheetFor] ?? null) : null}
        onPick={(mode) => {
          if (modeSheetFor) pickMode(modeSheetFor, mode);
        }}
        onClose={() => setModeSheetFor(null)}
      />

      <MakeRuleSheetV3
        assistantId={assistantId}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />

      <UndoToast toast={toast} onClear={() => setToast(null)} />
    </YouScreen>
  );
}
