/**
 * Needs you — pending approvals / interactions awaiting the user.
 *
 * Source: `pendinginteractionsGet` with NO conversation filter, whose 200 body
 * carries a typed `interactions: Array<{ requestId, conversationId, kind,
 * toolName?, riskLevel? }>` — the only honest *global* approval source. The
 * sibling `guardianactionsPendingGet` is conversation-scoped (it requires a
 * `conversationId` query and returns an opaque `prompts: unknown[]`), so it
 * cannot drive a global queue and is intentionally not used here.
 *
 * Steer: each interaction is approvable via `guardianactionsDecisionPost({
 * requestId, action, conversationId })` — we have all three fields typed, so the
 * Approve/Decline buttons are real, not fake. Every row also offers "Review in
 * chat" to open the originating conversation. Provenance is the interaction's
 * `kind` (+ toolName when present) read straight off the payload.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router";

import {
  guardianactionsDecisionPostMutation,
  pendinginteractionsGetOptions,
  pendinginteractionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton, type PillTone } from "../activity-row";
import { C } from "../theme";

function riskTone(risk: string | undefined): PillTone {
  if (!risk) return "amber";
  const r = risk.toLowerCase();
  if (r.includes("high") || r.includes("critical")) return "danger";
  if (r.includes("low")) return "neutral";
  return "amber";
}

export function NeedsYouSection({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const query = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const key = pendinginteractionsGetQueryKey({
    path: { assistant_id: assistantId },
  });
  const decide = useMutation({
    ...guardianactionsDecisionPostMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const interactions = query.data?.interactions ?? [];
  const empty =
    !query.isLoading && !query.isError && interactions.length === 0;

  return (
    <ActivitySection
      icon={ShieldAlert}
      title="Needs you"
      accent={C.danger}
      count={interactions.length}
      loading={query.isLoading}
      loadingLabel="Checking for approvals…"
      error={query.isError}
      empty={empty}
      emptyLabel="Nothing waiting on you — Cue will surface approvals here the moment it needs a decision."
    >
      {interactions.map((it, i) => {
        const provenance = it.toolName
          ? `${it.kind} · ${it.toolName}`
          : it.kind;
        return (
          <ActivityRow
            key={it.requestId}
            dotColor={C.danger}
            title={it.toolName ?? it.kind ?? "Approval required"}
            subtitle="Cue is waiting for your decision before it continues."
            provenance={provenance}
            statusLabel={it.riskLevel ?? "review"}
            statusTone={riskTone(it.riskLevel)}
            last={i === interactions.length - 1}
            actions={
              <>
                <RowButton
                  label="Approve"
                  variant="primary"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({
                      path: { assistant_id: assistantId },
                      body: {
                        requestId: it.requestId,
                        action: "approve",
                        conversationId: it.conversationId,
                      },
                    })
                  }
                />
                <RowButton
                  label="Decline"
                  variant="danger"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({
                      path: { assistant_id: assistantId },
                      body: {
                        requestId: it.requestId,
                        action: "decline",
                        conversationId: it.conversationId,
                      },
                    })
                  }
                />
                <RowButton
                  label="Review in chat"
                  variant="ghost"
                  onClick={() =>
                    navigate(`/assistant/conversations/${it.conversationId}`)
                  }
                />
              </>
            }
          />
        );
      })}
    </ActivitySection>
  );
}
