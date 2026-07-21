/**
 * Queued — work-items waiting to run (`workitemsGet?status=pending`).
 *
 * The status enum has no "queued" — `pending` is the queued bucket (see
 * WorkitemsGetData in types.gen.ts). Steer: Run now
 * (`workitemsByIdRunPost`) / Cancel (`workitemsByIdCancelPost`). Provenance is
 * derived in use-work-items from the payload's origin/source/trigger field.
 *
 * A row the pre-run assessment parked (it needs an answer, or one missing
 * thing) says why on its own line and wears the work-loop "needs you" badge —
 * and its Run drops to "Run anyway", because offering a confident "Run now"
 * for something Cue has just said it cannot do well is the dishonest part.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";

import {
  workitemsByIdCancelPostMutation,
  workitemsByIdRunPostMutation,
  workitemsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  AssessmentSignal,
  holdReason,
  holdsForYou,
} from "@/pages/hq/assessment-kit";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton } from "../activity-row";
import { C } from "../theme";
import { useWorkItems } from "../use-work-items";

export function QueuedSection({
  assistantId,
  focusId,
}: {
  assistantId: string;
  /** Work-item id from Home's `?focus=` deep-link; highlights the matching row. */
  focusId?: string | null;
}) {
  const queryClient = useQueryClient();
  const pending = useWorkItems(assistantId, "pending");

  const pendingKey = workitemsGetQueryKey({
    path: { assistant_id: assistantId },
    query: { status: "pending" },
  });
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: pendingKey });

  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    ...workitemsByIdCancelPostMutation(),
    onSuccess: invalidate,
  });
  const mutating = run.isPending || cancel.isPending;

  const empty =
    !pending.isLoading && !pending.isError && pending.items.length === 0;

  return (
    <ActivitySection
      icon={ListChecks}
      title="Cued"
      accent={C.amber}
      count={pending.items.length}
      loading={pending.isLoading}
      loadingLabel="Loading the queue…"
      error={pending.isError}
      empty={empty}
      emptyLabel="Nothing cued — Cue lines up background work here before it runs."
    >
      {pending.items.map((item, i) => {
        // The pre-run assessment parked this one: it is waiting on a person,
        // so the row says why and "Run now" stops being the confident answer.
        const held = holdsForYou(item.assessed);
        return (
          <ActivityRow
            key={item.id}
            dotColor={C.amber}
            title={item.title}
            subtitle={holdReason(item.assessed)}
            provenance={item.provenance}
            statusLabel="cued"
            statusTone="amber"
            last={i === pending.items.length - 1}
            highlight={item.id === focusId}
            actions={
              <>
                <AssessmentSignal item={item.assessed} />
                <RowButton
                  label={held ? "Run anyway" : "Run now"}
                  variant={held ? "ghost" : "primary"}
                  disabled={mutating}
                  onClick={() =>
                    run.mutate({
                      path: { assistant_id: assistantId, id: item.id },
                    })
                  }
                />
                <RowButton
                  label="Cancel"
                  variant="danger"
                  disabled={mutating}
                  onClick={() =>
                    cancel.mutate({
                      path: { assistant_id: assistantId, id: item.id },
                    })
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
