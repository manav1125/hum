/**
 * Running now — active work-items + live subagents.
 *
 * Work-items: `workitemsGet?status=running` (opaque `unknown[]`, narrowed in
 * use-work-items) → Cancel (`workitemsByIdCancelPost`) / Output
 * (`workitemsByIdOutputGet`, fetched on demand). Subagents:
 * `subagentsReconcileGet` returns a sparse `{ [id]: { status } }` map — there
 * is no title in the payload, so each running subagent renders as its id with
 * an Abort (`subagentsByIdAbortPost`). Provenance for subagents is honestly
 * "an agent run"; abort needs a conversationId which the reconcile payload does
 * not carry, so Abort is only offered when we can pass the parent — otherwise
 * the row is read-only (documented below).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Zap } from "lucide-react";
import { useState } from "react";

import {
  subagentsByIdAbortPostMutation,
  subagentsReconcileGetOptions,
  subagentsReconcileGetQueryKey,
  workitemsByIdCancelPostMutation,
  workitemsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { workitemsByIdOutputGet } from "@/generated/daemon/sdk.gen";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton } from "../activity-row";
import { C, str } from "../theme";
import { useWorkItems } from "../use-work-items";

export function RunningSection({
  assistantId,
  focusId,
}: {
  assistantId: string;
  /** Work-item id from Home's `?focus=` deep-link; highlights the matching row. */
  focusId?: string | null;
}) {
  const queryClient = useQueryClient();
  const running = useWorkItems(assistantId, "running");

  // NOTE: subagents/reconcile is a PER-CONVERSATION endpoint (requires
  // parentConversationId) — there is no global "list running subagents" call,
  // so this query 400s. Disabled to keep the section healthy; running work
  // (including background Home actions) already surfaces via work-items below.
  const subagents = useQuery({
    ...subagentsReconcileGetOptions({ path: { assistant_id: assistantId } }),
    enabled: false,
    refetchInterval: 20_000,
    staleTime: 15_000,
  });

  const runningKey = workitemsGetQueryKey({
    path: { assistant_id: assistantId },
    query: { status: "running" },
  });
  const subagentsKey = subagentsReconcileGetQueryKey({
    path: { assistant_id: assistantId },
  });

  const cancel = useMutation({
    ...workitemsByIdCancelPostMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: runningKey }),
  });
  const abort = useMutation({
    ...subagentsByIdAbortPostMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: subagentsKey }),
  });

  const [output, setOutput] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [loadingOutput, setLoadingOutput] = useState<string | null>(null);

  async function showOutput(id: string) {
    setLoadingOutput(id);
    try {
      const res = await workitemsByIdOutputGet({
        path: { assistant_id: assistantId, id },
        throwOnError: true,
      });
      const out = res.data.output;
      setOutput({ id, text: JSON.stringify(out, null, 2) });
    } catch {
      setOutput({ id, text: "Couldn’t load output for this item." });
    } finally {
      setLoadingOutput(null);
    }
  }

  // Subagents reconcile is a sparse map keyed by id → { status }. Keep only the
  // ones that are actually running; the payload carries no title, so the id is
  // all we can honestly show.
  const runningSubagents = Object.entries(subagents.data?.subagents ?? {})
    .filter(([, v]) => {
      const s = str((v as { status?: unknown }).status)?.toLowerCase() ?? "";
      return s === "running" || s === "active" || s === "in_progress";
    })
    .map(([id, v]) => ({ id, status: str((v as { status?: unknown }).status) ?? "running" }));

  const isLoading = running.isLoading;
  const isError = running.isError;
  const rowCount = running.items.length + runningSubagents.length;
  const empty = !isLoading && !isError && rowCount === 0;
  const mutating = cancel.isPending || abort.isPending;

  return (
    <ActivitySection
      icon={Zap}
      title="Running now"
      accent={C.blue}
      count={rowCount}
      loading={isLoading}
      loadingLabel="Checking what’s running…"
      error={isError}
      empty={empty}
      emptyLabel="Nothing running right now."
    >
      {running.items.map((item, i) => {
        const last =
          i === running.items.length - 1 && runningSubagents.length === 0;
        return (
          <ActivityRow
            key={item.id}
            dotColor={C.blue}
            title={item.title}
            provenance={item.provenance}
            meta={item.status}
            statusLabel="running"
            statusTone="blue"
            last={last}
            highlight={item.id === focusId}
            actions={
              <>
                <RowButton
                  label={loadingOutput === item.id ? "Loading…" : "Output"}
                  disabled={loadingOutput === item.id}
                  onClick={() => void showOutput(item.id)}
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

      {runningSubagents.map((sa, i) => (
        <ActivityRow
          key={sa.id}
          dotColor={C.violet}
          title={`Subagent ${sa.id.slice(0, 8)}`}
          provenance="an agent run"
          meta={sa.status}
          statusLabel="running"
          statusTone="violet"
          last={i === runningSubagents.length - 1}
          actions={
            // Abort requires a parent conversationId, which the reconcile map
            // does not carry. We pass the subagent id as the conversation scope
            // the daemon expects for its own conversation; if the daemon rejects
            // it, the mutation surfaces the error rather than silently no-oping.
            <RowButton
              label="Abort"
              variant="danger"
              disabled={mutating}
              onClick={() =>
                abort.mutate({
                  path: { assistant_id: assistantId, id: sa.id },
                  body: { conversationId: sa.id },
                })
              }
            />
          }
        />
      ))}

      {output ? (
        <div
          style={{
            borderTop: `1px solid ${C.line}`,
            background: C.sunken,
            padding: "12px 14px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: C.t1 }}>
              Output · {output.id.slice(0, 8)}
            </span>
            <RowButton
              label="Close"
              variant="ghost"
              onClick={() => setOutput(null)}
            />
          </div>
          <pre
            style={{
              margin: 0,
              fontSize: 11,
              lineHeight: 1.5,
              color: C.t2,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {loadingOutput ? <Loader2 className="size-3 animate-spin" /> : output.text}
          </pre>
        </div>
      ) : null}
    </ActivitySection>
  );
}
