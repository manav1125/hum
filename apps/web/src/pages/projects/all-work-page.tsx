/**
 * All work — one flat, groupable list of every live work item. Grouping is a
 * client-side toggle (status / project / due) over a single fetch; rows keep
 * the Activity design language.
 */

import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ActivityRow } from "@/domains/activity/activity-row";
import { DueChip } from "@/domains/activity/due-chip";
import { GroupBlock, GroupHeader } from "@/domains/activity/group-header";
import { C, mono } from "@/domains/activity/theme";
import {
  useWorkItems,
  type WorkItemView,
} from "@/domains/activity/use-work-items";
import { useActivitySync } from "@/hooks/use-activity-sync";

import { useProjects } from "./use-projects";

type Grouping = "status" | "project" | "due";

const STATUS_ORDER = ["awaiting_review", "running", "queued", "done", "failed"];
const STATUS_LABEL: Record<string, string> = {
  awaiting_review: "Review",
  running: "In motion",
  queued: "Queued",
  done: "Done",
  failed: "Failed",
};

function dueBucket(item: WorkItemView, now: number): string {
  if (item.dueAt == null) return "No date";
  const d = item.dueAt - now;
  if (d < 0) return "Overdue";
  if (d < 86_400_000) return "Today";
  if (d < 7 * 86_400_000) return "This week";
  return "Later";
}

const DUE_ORDER = ["Overdue", "Today", "This week", "Later", "No date"];

export function AllWorkPage() {
  const assistantId = useActiveAssistantId();
  useActivitySync(assistantId, true);
  const [grouping, setGrouping] = useState<Grouping>("status");
  // Stable reference time for due-bucketing (purity rule: no Date.now() in render).
  const [now] = useState(() => Date.now());

  // The unfiltered bucket returns every status; keep the live ones + recent
  // terminal ones and let grouping arrange them.
  const all = useWorkItems(assistantId);
  const { projects } = useProjects(assistantId);
  const projectTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, `${p.emoji ?? "📁"} ${p.title}`);
    return m;
  }, [projects]);

  const items = useMemo(
    () =>
      all.items.filter(
        (i) => i.status !== "archived" && i.status !== "cancelled",
      ),
    [all.items],
  );

  const groups = useMemo(() => {
    const map = new Map<string, WorkItemView[]>();
    for (const item of items) {
      const key =
        grouping === "status"
          ? (STATUS_LABEL[item.status] ?? item.status)
          : grouping === "project"
            ? (item.projectId && projectTitle.get(item.projectId)) ||
              "No project"
            : dueBucket(item, now);
      const bucket = map.get(key) ?? [];
      bucket.push(item);
      map.set(key, bucket);
    }
    const order =
      grouping === "status"
        ? STATUS_ORDER.map((s) => STATUS_LABEL[s] ?? s)
        : grouping === "due"
          ? DUE_ORDER
          : [...map.keys()].sort((a, b) =>
              a === "No project"
                ? 1
                : b === "No project"
                  ? -1
                  : a.localeCompare(b),
            );
    return order
      .filter((k) => map.has(k))
      .concat([...map.keys()].filter((k) => !order.includes(k)))
      .map((k) => ({ key: k, items: map.get(k)! }));
  }, [items, grouping, projectTitle, now]);

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div
        style={{ maxWidth: 880, margin: "0 auto", padding: "34px 22px 60px" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <GroupHeader
            kicker="All work"
            title="Everything, one list."
            accent={C.violet}
            hint="Every live item Cue is tracking, however it arrived."
          />
          <div
            role="radiogroup"
            aria-label="Group by"
            data-coach="work-view"
            style={{ display: "inline-flex", gap: 4, paddingBottom: 18 }}
          >
            {(["status", "project", "due"] as const).map((g) => (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={grouping === g}
                onClick={() => setGrouping(g)}
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  padding: "4px 10px",
                  borderRadius: 7,
                  border: `1px solid ${grouping === g ? C.ink : C.line2}`,
                  background: grouping === g ? C.ink : "transparent",
                  color: grouping === g ? C.bg : C.t3,
                  cursor: "pointer",
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        {all.isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: C.t2,
            }}
          >
            <Loader2 className="size-4 animate-spin" /> Loading your work…
          </div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 13, color: C.t3 }}>
            Nothing live right now — captured work shows up here the moment it
            lands.
          </div>
        ) : (
          groups.map((group) => (
            <GroupBlock key={group.key}>
              <GroupHeader
                kicker={group.key}
                title={`${group.items.length}`}
                accent={C.t2}
              />
              {group.items.slice(0, 20).map((item, i) => (
                <ActivityRow
                  key={item.id}
                  dotColor={
                    item.status === "done"
                      ? C.green
                      : item.status === "running"
                        ? C.blue
                        : C.amber
                  }
                  title={item.title}
                  provenance={item.provenance}
                  meta={
                    item.projectId
                      ? (projectTitle.get(item.projectId) ?? null)
                      : null
                  }
                  statusLabel={item.status.replace("_", " ")}
                  statusTone={
                    item.status === "done"
                      ? "green"
                      : item.status === "failed"
                        ? "danger"
                        : item.status === "running"
                          ? "blue"
                          : "amber"
                  }
                  last={i === Math.min(group.items.length, 20) - 1}
                  actions={<DueChip dueAt={item.dueAt} status={item.status} />}
                />
              ))}
            </GroupBlock>
          ))
        )}
      </div>
    </div>
  );
}
