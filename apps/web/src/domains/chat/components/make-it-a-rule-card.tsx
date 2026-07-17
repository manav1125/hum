/**
 * MakeItARuleCard — the in-context "Make it a rule" card (autonomy-states v2).
 *
 * Shown right after the owner confirms a one-off inbound commitment. It offers
 * to promote that decision into a STANDING auto-confirm rule so the same class
 * of work runs automatically next time instead of parking for approval. Honest
 * by construction: it only surfaces the rule options it actually has data for —
 * the scope-narrow "from <sender>" and the scope-wide "anything from
 * <channel>". Persistence is orthogonal to the live confirmation (this never
 * resolves it); the created rule is consulted by the work-item auto-run gate.
 *
 * Self-contained: mount it with the just-confirmed item's context + callbacks.
 * Theme-aware via the --mv1-* / --state-* token families (both are redefined
 * per-theme in the app stylesheet).
 */

import { Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { routes } from "@/utils/routes";
import {
  type MakeRuleInput,
  type MakeRuleTriggerType,
  useMakeRule,
} from "../hooks/use-make-rule";

const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";
const C = {
  blueS: "var(--mv1-blue-strong)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--state-done, var(--mv1-green))",
} as const;

/** A concrete rule the user can opt into, with its plain-English framing. */
interface RuleOption {
  key: string;
  input: MakeRuleInput;
  /** Short chip label ("from Rachel"). */
  chip: string;
  /** Full plain-English rule sentence for the confirm framing. */
  sentence: string;
}

export interface MakeItARuleCardProps {
  /** Who the just-confirmed item was from (display name / handle). */
  sender?: string | null;
  /** Where it arrived (channel id, e.g. "slack"). */
  channel?: string | null;
  /**
   * The autonomy category of the confirmed action (research / draft / send /
   * …). Used as a fallback option only when there's no sender or channel.
   */
  category?: string | null;
  /** Provenance: the work item this was promoted from. */
  sourceWorkItemId?: string;
  /** Provenance: the task this was promoted from. */
  sourceTaskId?: string;
  /** Override the active assistant id (defaults to the resolved active one). */
  assistantId?: string;
  /** Dismissed ("Not now") or finished — the host can unmount the card. */
  onDismiss?: () => void;
  /** Fired after a rule is created (e.g. to log / animate). */
  onRuleCreated?: (trigger: MakeRuleTriggerType, value: string) => void;
}

function channelLabel(channel: string): string {
  const c = channel.trim();
  return c.length === 0 ? c : c.charAt(0).toUpperCase() + c.slice(1);
}

/** Build the honest set of options from the context we actually have. */
function buildOptions(props: MakeItARuleCardProps): RuleOption[] {
  const provenance = {
    ...(props.sourceWorkItemId
      ? { sourceWorkItemId: props.sourceWorkItemId }
      : {}),
    ...(props.sourceTaskId ? { sourceTaskId: props.sourceTaskId } : {}),
  };
  const options: RuleOption[] = [];
  const sender = props.sender?.trim();
  const channel = props.channel?.trim();
  const category = props.category?.trim();

  if (sender) {
    options.push({
      key: "sender",
      chip: `from ${sender}`,
      sentence: `Auto-confirm anything from ${sender}`,
      input: { triggerType: "sender", triggerValue: sender, ...provenance },
    });
  }
  if (channel) {
    options.push({
      key: "channel",
      chip: `anything from ${channelLabel(channel)}`,
      sentence: `Auto-confirm anything from ${channelLabel(channel)}`,
      input: { triggerType: "channel", triggerValue: channel, ...provenance },
    });
  }
  // Category is a fallback only — surfaced when there's no sender/channel to
  // scope to, so the card is never empty for a legitimately-confirmed action.
  if (options.length === 0 && category) {
    options.push({
      key: "category",
      chip: `${category} actions`,
      sentence: `Auto-confirm ${category} actions`,
      input: { triggerType: "category", triggerValue: category, ...provenance },
    });
  }
  return options;
}

export function MakeItARuleCard(props: MakeItARuleCardProps) {
  const options = useMemo(() => buildOptions(props), [props]);
  const [selectedKey, setSelectedKey] = useState<string>(
    () => options[0]?.key ?? "",
  );
  const [savedSentence, setSavedSentence] = useState<string | null>(null);
  const { makeRule, isPending } = useMakeRule(props.assistantId);

  // Nothing to scope a rule to — render nothing rather than an empty prompt.
  if (options.length === 0) return null;

  const selected =
    options.find((o) => o.key === selectedKey) ?? options[0];

  if (savedSentence) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "12px 14px",
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
        }}
      >
        <Check size={15} style={{ color: C.green, flexShrink: 0 }} />
        <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5 }}>
          Rule saved — &ldquo;{savedSentence}&rdquo;. Cue will handle these
          automatically from now on.{" "}
          <Link
            to={routes.guardrails}
            style={{ color: C.blueS, textDecoration: "none" }}
          >
            Change anytime in the Trust console
          </Link>
          .
        </div>
      </div>
    );
  }

  const save = async () => {
    if (!selected || isPending) return;
    const rule = await makeRule(selected.input);
    if (rule) {
      setSavedSentence(selected.sentence);
      props.onRuleCreated?.(selected.input.triggerType, selected.input.triggerValue);
    }
  };

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line2}`,
        borderRadius: 12,
        padding: 14,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.blueS,
        }}
      >
        Make it a rule
      </div>
      <div
        style={{
          fontFamily: serif,
          fontSize: 20,
          color: C.t1,
          marginTop: 8,
          lineHeight: 1.25,
        }}
      >
        Want Cue to auto-confirm these next time?
      </div>

      {/* Honest scope options — narrowest first. Only what we have data for. */}
      <div
        role="radiogroup"
        aria-label="Rule scope"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 13 }}
      >
        {options.map((o) => {
          const active = o.key === selected.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelectedKey(o.key)}
              style={{
                fontSize: 12.5,
                fontWeight: active ? 600 : 400,
                color: active ? C.t1 : C.t2,
                background: active ? C.sunken : "transparent",
                border: `1px solid ${active ? C.line2 : C.line}`,
                borderRadius: 8,
                padding: "8px 13px",
                cursor: "pointer",
              }}
            >
              {o.chip}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 16,
        }}
      >
        <Button
          variant="primary"
          onClick={save}
          disabled={isPending}
          leftIcon={
            isPending ? <Loader2 className="size-3.5 animate-spin" /> : undefined
          }
        >
          Make it a rule
        </Button>
        <Button variant="ghost" onClick={() => props.onDismiss?.()}>
          Not now
        </Button>
      </div>

      <div
        style={{
          fontSize: 11,
          color: C.t3,
          marginTop: 12,
          lineHeight: 1.5,
        }}
      >
        Applies to future inbound work that matches — Cue still asks before
        anything irreversible.{" "}
        <Link
          to={routes.guardrails}
          style={{ color: C.t3, textDecoration: "underline" }}
        >
          Change anytime in the Trust console
        </Link>
        .
      </div>
    </div>
  );
}
