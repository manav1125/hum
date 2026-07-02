/**
 * Project detail — the per-project work stream. The Command Center's calm
 * vertical acts (Queued / In motion / Review / Done), scoped to one project.
 * One fetch powers all four lanes (client-side status split).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ActivityRow, RowButton } from "@/domains/activity/activity-row";
import { DueChip } from "@/domains/activity/due-chip";
import { GroupBlock, GroupHeader } from "@/domains/activity/group-header";
import { C, mono, relativeTime, serif } from "@/domains/activity/theme";
import { useActivitySync } from "@/hooks/use-activity-sync";
import {
  projectsByIdGetOptions,
  projectsByIdPatchMutation,
  projectsByIdWorkitemsGetOptions,
  projectsByIdWorkitemsGetQueryKey,
  workitemsByIdCompletePostMutation,
  workitemsByIdRunPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";

type Row = {
  id: string;
  title: string;
  status: string;
  dueAt: number | null;
  updatedAt: number | null;
};

const LANES: ReadonlyArray<{
  key: string;
  statuses: readonly string[];
  kicker: string;
  title: string;
  accent: string;
}> = [
  { key: "queued", statuses: ["queued"], kicker: "Queued", title: "Waiting to run.", accent: C.amber },
  { key: "running", statuses: ["running"], kicker: "In motion", title: "Cue is on it.", accent: C.blue },
  { key: "review", statuses: ["awaiting_review"], kicker: "Review", title: "Ready for sign-off.", accent: C.amber },
  { key: "done", statuses: ["done"], kicker: "Done", title: "Handled.", accent: C.green },
];

export function ProjectDetailPage() {
  const assistantId = useActiveAssistantId();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useActivitySync(assistantId, true);

  const project = useQuery({
    ...projectsByIdGetOptions({
      path: { assistant_id: assistantId, id: projectId },
    }),
    staleTime: 30_000,
  });

  const items = useQuery({
    ...projectsByIdWorkitemsGetOptions({
      path: { assistant_id: assistantId, id: projectId },
    }),
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const rows: Row[] = useMemo(
    () =>
      (items.data?.items ?? []).map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        dueAt: i.dueAt ?? null,
        updatedAt: i.updatedAt ?? null,
      })),
    [items.data?.items],
  );

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: projectsByIdWorkitemsGetQueryKey({
        path: { assistant_id: assistantId, id: projectId },
      }),
    });
  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSettled: invalidate,
  });
  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    onSettled: invalidate,
  });
  const archive = useMutation({ ...projectsByIdPatchMutation() });

  const p = project.data?.project;

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "34px 22px 60px" }}>
        <Link
          to={routes.projects}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: mono,
            fontSize: 11.5,
            color: C.t3,
            textDecoration: "none",
            marginBottom: 14,
          }}
        >
          <ArrowLeft size={12} /> All projects
        </Link>

        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 26,
          }}
        >
          <div
            style={{
              fontFamily: serif,
              fontSize: 30,
              letterSpacing: "-0.5px",
              color: C.ink,
            }}
          >
            {p ? `${p.emoji ?? "📁"} ${p.title}` : "…"}
          </div>
          {p && p.status === "active" ? (
            <RowButton
              label={archive.isPending ? "Archiving…" : "Archive"}
              variant="ghost"
              disabled={archive.isPending}
              onClick={() =>
                archive.mutate(
                  {
                    path: { assistant_id: assistantId, id: projectId },
                    body: { status: "archived" },
                  },
                  { onSuccess: () => navigate(routes.projects) },
                )
              }
            />
          ) : null}
        </div>

        {items.isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: C.t2,
            }}
          >
            <Loader2 className="size-4 animate-spin" /> Loading the project’s
            work…
          </div>
        ) : (
          LANES.map((lane) => {
            const laneRows = rows.filter((r) => lane.statuses.includes(r.status));
            if (laneRows.length === 0) return null;
            return (
              <GroupBlock key={lane.key}>
                <GroupHeader
                  kicker={lane.kicker}
                  title={lane.title}
                  accent={lane.accent}
                />
                {laneRows.slice(0, 12).map((r, i) => (
                  <ActivityRow
                    key={r.id}
                    dotColor={lane.accent}
                    title={r.title}
                    meta={r.updatedAt ? relativeTime(r.updatedAt) : null}
                    statusLabel={r.status.replace("_", " ")}
                    statusTone={
                      r.status === "done"
                        ? "green"
                        : r.status === "running"
                          ? "blue"
                          : "amber"
                    }
                    last={i === Math.min(laneRows.length, 12) - 1}
                    actions={
                      <>
                        <DueChip dueAt={r.dueAt} status={r.status} />
                        {r.status === "queued" ? (
                          <RowButton
                            label={run.isPending ? "Starting…" : "Run now"}
                            disabled={run.isPending}
                            onClick={() =>
                              run.mutate({
                                path: { assistant_id: assistantId, id: r.id },
                              })
                            }
                          />
                        ) : null}
                        {r.status === "awaiting_review" ? (
                          <RowButton
                            label={approve.isPending ? "Approving…" : "Approve"}
                            disabled={approve.isPending}
                            onClick={() =>
                              approve.mutate({
                                path: { assistant_id: assistantId, id: r.id },
                              })
                            }
                          />
                        ) : null}
                      </>
                    }
                  />
                ))}
              </GroupBlock>
            );
          })
        )}

        {!items.isLoading && rows.length === 0 ? (
          <div style={{ fontSize: 13, color: C.t3 }}>
            Nothing filed here yet — new work that matches this project gets
            grouped in automatically.
          </div>
        ) : null}
      </div>
    </div>
  );
}
