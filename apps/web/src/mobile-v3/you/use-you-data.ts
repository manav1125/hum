/**
 * Real-data hooks shared across the YOU cluster (frames 9/20/31).
 *
 * Nothing here fabricates a number:
 *  · The mode dial reads/writes the gateway per-category autonomy policies
 *    (`lib/autonomy-policies-api.ts`) — the SAME store the Settings → Privacy
 *    autonomy card persists. The three dial positions are exact policy
 *    postures; a hand-tuned map matches no position and reads as custom.
 *  · Track record + rules ride the composed `guardrailsGet` read (7d window)
 *    and the standing trust-rules store (`trust/rules`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  guardrailsGetOptions,
  trustRulesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  GuardrailsGetResponse,
  TrustRulesGetResponse,
} from "@/generated/daemon/types.gen";
import {
  AUTONOMY_CATEGORIES,
  getAutonomyPolicies,
  setAutonomyPolicies,
  type AutonomyCategory,
  type AutonomyPolicies,
} from "@/lib/autonomy-policies-api";

// ---------------------------------------------------------------------------
// Mode dial — Observe / Assist / Autonomous as exact policy postures.
// ---------------------------------------------------------------------------

export type DialMode = "observe" | "assist" | "autonomous";

/**
 * The three dial postures over the 6-category policy map. `assist` and
 * `autonomous` mirror the Settings card's CONSERVATIVE/AUTONOMOUS presets;
 * `observe` keeps only research running alone.
 */
export const DIAL_PRESETS: Record<DialMode, AutonomyPolicies> = {
  observe: {
    research: "auto",
    draft: "ask",
    send: "ask",
    money: "ask",
    delete: "ask",
    other: "ask",
  },
  assist: {
    research: "auto",
    draft: "auto",
    send: "ask",
    money: "ask",
    delete: "ask",
    other: "ask",
  },
  autonomous: {
    research: "auto",
    draft: "auto",
    send: "auto",
    other: "auto",
    money: "ask",
    delete: "ask",
  },
};

function policiesMatch(a: AutonomyPolicies, b: AutonomyPolicies): boolean {
  return AUTONOMY_CATEGORIES.every((c) => a[c] === b[c]);
}

/** Which dial position the current policy map sits at; null = hand-tuned. */
export function dialModeOf(policies: AutonomyPolicies): DialMode | null {
  for (const mode of ["observe", "assist", "autonomous"] as const) {
    if (policiesMatch(policies, DIAL_PRESETS[mode])) return mode;
  }
  return null;
}

const CATEGORY_PHRASE: Record<AutonomyCategory, string> = {
  research: "research",
  draft: "drafts",
  send: "sending",
  money: "spending",
  delete: "deleting",
  other: "other actions",
};

/**
 * The dial's honest description line, derived from the ACTUAL policy values
 * (frame grammar: "Runs research & drafts alone · always asks before sending
 * or spending").
 */
export function dialDescription(policies: AutonomyPolicies): string {
  const auto = AUTONOMY_CATEGORIES.filter((c) => policies[c] === "auto");
  const ask = AUTONOMY_CATEGORIES.filter((c) => policies[c] === "ask");
  const never = AUTONOMY_CATEGORIES.filter((c) => policies[c] === "never");

  const join = (cats: AutonomyCategory[]) => {
    const words = cats.map((c) => CATEGORY_PHRASE[c]);
    if (words.length <= 1) return words[0] ?? "";
    if (words.length === 2) return `${words[0]} & ${words[1]}`;
    return `${words.slice(0, -1).join(", ")} & ${words[words.length - 1]}`;
  };

  const parts: string[] = [];
  parts.push(
    auto.length > 0
      ? `Runs ${join(auto.slice(0, 3))} alone`
      : "Runs nothing alone",
  );
  if (ask.length > 0) {
    parts.push(`always asks before ${join(ask.slice(0, 2))}`);
  }
  if (never.length > 0) {
    parts.push(`never ${join(never.slice(0, 2))}`);
  }
  return parts.join(" · ");
}

export function useAutonomyDial(assistantId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    // Same key as the Settings autonomy card so the two stay coherent.
    queryKey: ["autonomy-policies", assistantId],
    queryFn: () => getAutonomyPolicies(assistantId),
    staleTime: 30_000,
    enabled: assistantId.length > 0,
  });

  const setMode = useMutation({
    mutationFn: (mode: DialMode) =>
      setAutonomyPolicies(assistantId, DIAL_PRESETS[mode]),
    onMutate: (mode) => {
      // Optimistic: the dial snaps immediately; the invalidate reconciles.
      queryClient.setQueryData(
        ["autonomy-policies", assistantId],
        DIAL_PRESETS[mode],
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["autonomy-policies", assistantId],
      });
    },
  });

  const setCategory = useMutation({
    mutationFn: async (vars: {
      category: AutonomyCategory;
      mode: AutonomyPolicies[AutonomyCategory];
    }) => setAutonomyPolicies(assistantId, { [vars.category]: vars.mode }),
    onMutate: (vars) => {
      const current = queryClient.getQueryData<AutonomyPolicies>([
        "autonomy-policies",
        assistantId,
      ]);
      if (current) {
        queryClient.setQueryData(["autonomy-policies", assistantId], {
          ...current,
          [vars.category]: vars.mode,
        });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["autonomy-policies", assistantId],
      });
    },
  });

  return { policies: query.data ?? null, isError: query.isError, setMode, setCategory };
}

// ---------------------------------------------------------------------------
// Guardrails (7d) + standing trust rules.
// ---------------------------------------------------------------------------

export type GuardrailsPayload = GuardrailsGetResponse;
export type StandingRule = TrustRulesGetResponse["rules"][number];

export function useGuardrails(assistantId: string) {
  const query = useQuery({
    ...guardrailsGetOptions({
      path: { assistant_id: assistantId },
      query: { days: 7 },
    }),
    staleTime: 30_000,
    enabled: assistantId.length > 0,
  });
  return {
    data: (query.data ?? null) as GuardrailsPayload | null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useStandingRules(assistantId: string) {
  const query = useQuery({
    ...trustRulesGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
    enabled: assistantId.length > 0,
  });
  return {
    rules: (query.data?.rules ?? []) as StandingRule[],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** "$4.10" from cents; null when the source is absent (never fake $0). */
export function usd(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  const d = cents / 100;
  if (d >= 100) return `$${Math.round(d)}`;
  return `$${d.toFixed(2)}`;
}
