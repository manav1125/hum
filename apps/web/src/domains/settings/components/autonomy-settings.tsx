import { useCallback, useEffect, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  AUTONOMY_CATEGORIES,
  getAutonomyPolicies,
  setAutonomyPolicies,
  type AutonomyCategory,
  type AutonomyMode,
  type AutonomyPolicies,
} from "@/lib/autonomy-policies-api";
import { Card } from "@vellumai/design-library/components/card";
import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellumai/design-library/components/segment-control";
import { Toggle } from "@vellumai/design-library/components/toggle";

/**
 * Grant TTL the daemon mints for approve-once decisions. Mirrors
 * `GRANT_TTL_MS` in `assistant/src/approvals/guardian-decision-primitive.ts`.
 * The value is a fixed daemon-side constant and is not exposed to the client,
 * so we surface it as a static explanatory note rather than reading it live.
 */
const APPROVAL_GRANT_MINUTES = 5;

const MODE_OPTIONS: SegmentControlItem<AutonomyMode>[] = [
  { value: "auto", label: "Auto" },
  { value: "ask", label: "Ask" },
  { value: "never", label: "Never" },
];

const CATEGORY_COPY: Record<
  AutonomyCategory,
  { label: string; descriptor: string }
> = {
  research: {
    label: "Research",
    descriptor: "Search, browse, read — gather information",
  },
  draft: {
    label: "Draft",
    descriptor: "Write and prepare content for your review",
  },
  send: {
    label: "Send",
    descriptor: "Emails, messages, replies",
  },
  money: {
    label: "Money",
    descriptor: "Purchases, payments, transfers",
  },
  delete: {
    label: "Delete",
    descriptor: "Remove files, records, or data",
  },
  other: {
    label: "Other",
    descriptor: "Anything that doesn't fit the categories above",
  },
};

/**
 * Autonomous posture: act freely on low-consequence categories, but always
 * confirm the two that are consequential and hard to undo.
 */
const AUTONOMOUS_PRESET: AutonomyPolicies = {
  research: "auto",
  draft: "auto",
  send: "auto",
  other: "auto",
  money: "ask",
  delete: "ask",
};

/**
 * Conservative posture: draft and research run on their own, but anything that
 * leaves the assistant — sending, spending, deleting — waits for you.
 */
const CONSERVATIVE_PRESET: AutonomyPolicies = {
  research: "auto",
  draft: "auto",
  send: "ask",
  other: "ask",
  money: "ask",
  delete: "ask",
};

function policiesMatch(a: AutonomyPolicies, b: AutonomyPolicies): boolean {
  return AUTONOMY_CATEGORIES.every((category) => a[category] === b[category]);
}

/**
 * The master toggle reads "on" only when the current policies already sit at
 * an autonomous posture (send + other on auto, money + delete still asking).
 * A partial match — someone who hand-tuned a single row — reads as "off".
 */
function isAutonomousPosture(policies: AutonomyPolicies): boolean {
  return policiesMatch(policies, AUTONOMOUS_PRESET);
}

function Divider() {
  return (
    <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
  );
}

export function AutonomySettings() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const {
    data: serverPolicies,
    isError: loadError,
    isLoading,
  } = useQuery({
    queryKey: ["autonomy-policies", assistantId],
    queryFn: () => getAutonomyPolicies(assistantId),
    staleTime: 30_000,
  });

  // Local mirror so segment clicks and the master toggle feel instant. Seeded
  // from the server response, then owned by the user once they interact.
  const [policies, setPolicies] = useState<AutonomyPolicies | null>(null);
  const hasUserInteracted = useRef(false);

  useEffect(() => {
    if (!serverPolicies || hasUserInteracted.current) return;
    setPolicies(serverPolicies);
  }, [serverPolicies]);

  const persist = useCallback(
    (next: AutonomyPolicies) => {
      setAutonomyPolicies(assistantId, next)
        .then(() => {
          queryClient.invalidateQueries({
            queryKey: ["autonomy-policies", assistantId],
          });
        })
        .catch(() => {
          // Silent — the optimistic local value stays. Changing a row again
          // re-issues the write, and the invalidate above reconciles on the
          // next successful save.
        });
    },
    [assistantId, queryClient],
  );

  const applyPolicies = useCallback(
    (next: AutonomyPolicies) => {
      hasUserInteracted.current = true;
      setPolicies(next);
      persist(next);
    },
    [persist],
  );

  const handleCategoryChange = useCallback(
    (category: AutonomyCategory, mode: AutonomyMode) => {
      setPolicies((current) => {
        const base = current ?? serverPolicies;
        if (!base) return current;
        const next = { ...base, [category]: mode };
        hasUserInteracted.current = true;
        persist(next);
        return next;
      });
    },
    [persist, serverPolicies],
  );

  const handleMasterToggle = useCallback(
    (nextOn: boolean) => {
      applyPolicies(nextOn ? AUTONOMOUS_PRESET : CONSERVATIVE_PRESET);
    },
    [applyPolicies],
  );

  const effective = policies ?? serverPolicies ?? null;
  const autonomousOn = effective ? isAutonomousPosture(effective) : false;
  const controlsDisabled = !effective;

  return (
    <Card>
      <h2 className="text-title-medium text-[var(--content-default)]">
        Autonomy
      </h2>
      <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
        Choose what your assistant does on its own and what it checks with you
        first. Set a default for each kind of action below.
      </p>

      {loadError && (
        <p className="mt-2 text-body-small-default text-[var(--system-negative-strong)]">
          Could not load autonomy settings. Check your connection and reload.
        </p>
      )}

      <div className="mt-4 space-y-4">
        {/* Master autonomous-mode toggle */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="text-body-medium-default text-[var(--content-default)]">
              Autonomous mode
            </div>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              Let your assistant research, draft, and send on its own. Cue
              always asks before money and deletions.
            </p>
          </div>
          <Toggle
            checked={autonomousOn}
            onChange={handleMasterToggle}
            disabled={controlsDisabled}
            aria-label="Autonomous mode"
          />
        </div>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          You can still stop anything mid-run. Turning this off keeps sending,
          money, and deletions on ask.
        </p>

        <Divider />

        {/* Per-category defaults */}
        {AUTONOMY_CATEGORIES.map((category, index) => {
          const copy = CATEGORY_COPY[category];
          const value = effective?.[category] ?? "ask";
          return (
            <div key={category} className="space-y-4">
              {index > 0 && <Divider />}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1">
                  <div className="text-body-medium-default text-[var(--content-default)]">
                    {copy.label}
                  </div>
                  <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
                    {copy.descriptor}
                  </p>
                </div>
                <div className="w-full sm:w-[220px] sm:shrink-0">
                  <SegmentControl<AutonomyMode>
                    items={MODE_OPTIONS}
                    value={value}
                    onChange={(mode) => handleCategoryChange(category, mode)}
                    ariaLabel={`${copy.label} default`}
                  />
                </div>
              </div>
            </div>
          );
        })}

        <Divider />

        <p className="text-body-small-default text-[var(--content-tertiary)]">
          Auto acts without asking. Ask always prompts you first. Never always
          declines. When your assistant asks and you approve, that approval
          expires after {APPROVAL_GRANT_MINUTES} minutes — after that, the same
          action asks again.
        </p>
      </div>

      {isLoading && !effective && (
        <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
          Loading autonomy settings…
        </p>
      )}
    </Card>
  );
}
