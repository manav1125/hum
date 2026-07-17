/**
 * useMakeRule — the mutation behind the in-context "Make it a rule" card.
 *
 * Promotes a just-confirmed one-off inbound commitment into a STANDING
 * auto-confirm rule ("auto-confirm anything from Rachel" / "anything from
 * Slack"), persisted via the daemon's standing-rules store. The work-item
 * auto-run gate consults the rule on the next matching capture, so the same
 * class of work stops parking for approval.
 *
 * Optimistic: the new rule is appended to the standing-rules list cache
 * immediately and reconciled/rolled back on settle. Fires a success/error
 * toast. Never resolves any live confirmation — that's an orthogonal concern.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  trustRulesGetQueryKey,
  trustRulesPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { TrustRulesGetResponse } from "@/generated/daemon/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { toast } from "@vellumai/design-library/components/toast";

/** A trigger axis for a standing auto-confirm rule. */
export type MakeRuleTriggerType = "sender" | "channel" | "category" | "tool";

export interface MakeRuleInput {
  /** What the rule keys off. */
  triggerType: MakeRuleTriggerType;
  /** The value it matches — sender name, channel id, category, or tool name. */
  triggerValue: string;
  /** Optional plain-English label; the server generates one when omitted. */
  label?: string;
  /** Provenance: the work item this was promoted from. */
  sourceWorkItemId?: string;
  /** Provenance: the task this was promoted from. */
  sourceTaskId?: string;
}

type StandingRule = TrustRulesGetResponse["rules"][number];

export interface UseMakeRuleResult {
  /** Create the rule. Resolves to the created rule, or null on failure. */
  makeRule: (input: MakeRuleInput) => Promise<StandingRule | null>;
  isPending: boolean;
  /** True once a rule has been created in this card's lifetime. */
  isSuccess: boolean;
}

/**
 * @param assistantId  Override the active assistant (defaults to the resolved
 *                     active assistant). Chat renders across pre-active states,
 *                     so the null case is guarded internally.
 */
export function useMakeRule(assistantId?: string): UseMakeRuleResult {
  const activeAssistantId =
    useResolvedAssistantsStore.use.activeAssistantId() ?? "";
  const aid = assistantId ?? activeAssistantId;
  const queryClient = useQueryClient();

  const listKey = trustRulesGetQueryKey({ path: { assistant_id: aid } });

  const mutation = useMutation({
    ...trustRulesPostMutation(),
    onSuccess: () => {
      // The optimistic write already reflected the new rule; refetch to
      // reconcile with the server's canonical row (idempotent-dedupe aware).
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  const makeRule = async (
    input: MakeRuleInput,
  ): Promise<StandingRule | null> => {
    if (!aid) {
      toast.error("No active assistant — can't save the rule.");
      return null;
    }

    // Optimistic append to the standing-rules list cache, if it's loaded.
    await queryClient.cancelQueries({ queryKey: listKey });
    const previous =
      queryClient.getQueryData<TrustRulesGetResponse>(listKey);
    const optimistic: StandingRule = {
      id: `optimistic-${Date.now()}`,
      triggerType: input.triggerType,
      triggerValue: input.triggerValue,
      action: "auto_confirm",
      label: input.label ?? input.triggerValue,
      enabled: 1,
      sourceWorkItemId: input.sourceWorkItemId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (previous) {
      queryClient.setQueryData<TrustRulesGetResponse>(listKey, {
        ...previous,
        rules: [...previous.rules, optimistic],
      });
    }

    try {
      const res = await mutation.mutateAsync({
        path: { assistant_id: aid },
        body: {
          triggerType: input.triggerType,
          triggerValue: input.triggerValue.trim(),
          ...(input.label ? { label: input.label } : {}),
          ...(input.sourceWorkItemId
            ? { sourceWorkItemId: input.sourceWorkItemId }
            : {}),
          ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
        },
      });
      toast.success("Rule saved. Cue will handle these automatically.");
      return res.rule;
    } catch {
      // Roll back the optimistic append.
      if (previous) queryClient.setQueryData(listKey, previous);
      toast.error("Couldn't save the rule — try again.");
      return null;
    }
  };

  return {
    makeRule,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
  };
}
