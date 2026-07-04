/**
 * Review — AI-completed work waiting for your sign-off.
 *
 * This is the "bring it back" half of the work loop: items the background
 * runner finished land in `awaiting_review`, and this section surfaces each
 * one WITH its result (summary + highlights) so you can judge it without
 * opening the thread. Actions:
 *
 *   - Approve      → `workitemsByIdCompletePost` (awaiting_review → done)
 *   - Redo         → `workitemsByIdRunPost` (run the item again)
 *   - Open thread  → jump to the run conversation for the full trace
 *
 * Results come from the in-session `work_item_completed` store when we have
 * them (zero fetch); otherwise each row lazily pulls
 * `workitemsByIdOutputGet` so reloads still show what the AI produced.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";

import {
  workitemsByIdCompletePostMutation,
  workitemsByIdOutputGetOptions,
  workitemsByIdRunPostMutation,
  workitemsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useNavigate } from "react-router";

import {
  useWorkItemResultsStore,
  type WorkItemResult,
} from "@/stores/work-item-results-store";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton } from "../activity-row";
import { C, relativeTime, str } from "../theme";
import { useWorkItems, type WorkItemView } from "../use-work-items";
import { MoveToProject, ProjectTag } from "./project-move-control";

const MAX_ROWS = 10;

/** Narrow the opaque `output` payload into the bits the review card shows. */
function narrowOutput(raw: unknown): Partial<WorkItemResult> {
  if (!raw || typeof raw !== "object") return {};
  const rec = raw as Record<string, unknown>;
  const summary = str(rec.summary);
  const conversationId = str(rec.conversationId);
  const highlights = Array.isArray(rec.highlights)
    ? rec.highlights.filter((h): h is string => typeof h === "string")
    : [];
  return {
    ...(summary ? { summary } : {}),
    ...(conversationId ? { conversationId } : {}),
    highlights,
  };
}

function ReviewRow({
  assistantId,
  item,
  last,
}: {
  assistantId: string;
  item: WorkItemView;
  last: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inSession = useWorkItemResultsStore((s) => s.byId[item.id]);

  // Fetch the persisted run output only when the in-session store has nothing
  // (i.e. the completion happened before this page load).
  const output = useQuery({
    ...workitemsByIdOutputGetOptions({
      path: { assistant_id: assistantId, id: item.id },
    }),
    enabled: !inSession,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const result: Partial<WorkItemResult> =
    inSession ?? narrowOutput(output.data?.output);

  const invalidateBuckets = () => {
    for (const status of ["awaiting_review", "done", "running"] as const) {
      void queryClient.invalidateQueries({
        queryKey: workitemsGetQueryKey({
          path: { assistant_id: assistantId },
          query: { status },
        }),
      });
    }
  };

  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    onSettled: invalidateBuckets,
  });
  const redo = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSettled: invalidateBuckets,
  });
  const mutating = approve.isPending || redo.isPending;
  const pathOpts = { path: { assistant_id: assistantId, id: item.id } };

  const summary =
    result.summary ??
    (output.isLoading && !inSession ? "Loading the result…" : null);
  const highlights = result.highlights ?? [];
  const threadId = result.conversationId;

  return (
    <ActivityRow
      dotColor={C.amber}
      title={item.title}
      subtitle={summary}
      provenance={item.provenance}
      meta={item.at ? relativeTime(item.at) : null}
      statusLabel="ready for review"
      statusTone="amber"
      last={last}
      actions={
        <>
          <RowButton
            label={approve.isPending ? "Approving…" : "Approve"}
            disabled={mutating}
            onClick={() => approve.mutate(pathOpts)}
          />
          <RowButton
            label={redo.isPending ? "Redoing…" : "Redo"}
            variant="ghost"
            disabled={mutating}
            onClick={() => redo.mutate(pathOpts)}
          />
          {threadId ? (
            <RowButton
              label="Open thread"
              variant="ghost"
              onClick={() => navigate(`/assistant/conversations/${threadId}`)}
            />
          ) : null}
          <MoveToProject
            assistantId={assistantId}
            itemId={item.id}
            currentProjectId={item.projectId}
          />
        </>
      }
    >
      <div style={{ marginTop: 6 }}>
        <ProjectTag assistantId={assistantId} projectId={item.projectId} />
      </div>
      {highlights.length > 0 ? (
        <ul
          style={{
            margin: "6px 0 0",
            padding: "0 0 0 16px",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: C.t2,
          }}
        >
          {highlights.slice(0, 4).map((h, hi) => (
            <li key={hi}>{h}</li>
          ))}
        </ul>
      ) : null}
    </ActivityRow>
  );
}

export function AwaitingReviewSection({
  assistantId,
}: {
  assistantId: string;
}) {
  const awaiting = useWorkItems(assistantId, "awaiting_review");
  const rows = awaiting.items.slice(0, MAX_ROWS);
  const empty = !awaiting.isLoading && !awaiting.isError && rows.length === 0;

  return (
    <ActivitySection
      icon={ClipboardCheck}
      title="Review"
      accent={C.amber}
      count={awaiting.items.length || undefined}
      loading={awaiting.isLoading}
      loadingLabel="Checking for finished work…"
      error={awaiting.isError}
      empty={empty}
      emptyLabel="Nothing to review — when Cue finishes a piece of work, it lands here with the result for your sign-off."
    >
      {rows.map((item, i) => (
        <ReviewRow
          key={item.id}
          assistantId={assistantId}
          item={item}
          last={i === rows.length - 1}
        />
      ))}
    </ActivitySection>
  );
}
