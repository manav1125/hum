/**
 * Work → Everything — one flat, groupable list of every live task.
 *
 * This used to be "All work", its own destination in the nav. It is now
 * Work's second view: the tab and the ledger were both called work, and
 * merging them was the fix rather than renaming one of them again. Nothing
 * about the list changed in the move — the filters, search, bulk select and
 * the "Not in anything yet" bucket all came with it.
 *
 * Grouping by **thing** produces exactly the headers that Work → Things
 * lists, which is what makes the two views provably the same data rather than
 * two summaries that happen to agree.
 *
 * `/assistant/work` still resolves; it redirects here.
 */

import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

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
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { dismissLeave } from "@/mobile-v3/undo-toast";
import { fullPatchBody, isAutoFiled } from "@/mobile-v3/work-kit";
import { AssessmentSignal, holdReason } from "@/pages/hq/assessment-kit";
import { ProvenanceTrace } from "@/pages/hq/provenance-trace";
import { describeProvenance } from "@/pages/hq/work-provenance";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { useAddTasksStore } from "@/stores/add-tasks-store";
import { routes } from "@/utils/routes";

import {
  AutoFiledPill,
  FilingKitStyle,
  HoverX,
  RefilePopover,
  useDesktopDismiss,
} from "./filing-desktop";
import { Mv3AllWork } from "./mv3-all-work";
import { NewProjectModal } from "./new-project-modal";
import { usePatchWorkItem, useProjects } from "./use-projects";
import { WorkViewTabs } from "./work-views";
import { describeWorkState } from "@/pages/hq/work-vocabulary";

type Grouping = "status" | "thing" | "due";

/**
 * The bucket for tasks that belong to no thing yet. Named as a state of the
 * task ("not in anything yet") rather than an absence on the record ("no
 * project") — one is something to do, the other is a null.
 */
const UNFILED_LABEL = "Not in anything yet";

const STATUS_ORDER = ["awaiting_review", "running", "queued", "done", "failed"];
// Grouping headers read from the shared vocabulary so All work and HQ speak
// with one voice. They used to disagree — HQ said "needs you", this page said
// "Review"; HQ said "Cue is doing", this said "In motion" — which made the two
// surfaces look like two products with overlapping data. `failed` has no
// canonical entry (it is not one of the eight states a user acts on), so it
// keeps a local label.
const STATUS_LABEL: Record<string, string> = {
  awaiting_review: describeWorkState("awaiting_review").label,
  running: describeWorkState("running").label,
  queued: describeWorkState("queued").label,
  done: describeWorkState("done").label,
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

/**
 * Mobile renders the v3 native list (Mv3AllWork); desktop keeps the Activity
 * list below byte-identical — the same split projects-page.tsx uses.
 */
export function AllWorkPage() {
  const isMobile = useMobileLayout();
  return isMobile ? <Mv3AllWork /> : <AllWorkPageDesktop />;
}

function AllWorkPageDesktop() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);
  const [grouping, setGrouping] = useState<Grouping>("status");
  // Stable reference time for due-bucketing (purity rule: no Date.now() in render).
  const [now] = useState(() => Date.now());
  const openAddTasks = useAddTasksStore.use.open();

  // The unfiltered bucket returns every status; keep the live ones + recent
  // terminal ones and let grouping arrange them.
  const all = useWorkItems(assistantId);
  // Full typed records alongside the narrowed view: the archive PATCH and the
  // re-file PATCH must send the daemon's FULL record (same trick Mv3AllWork
  // uses), and ✨ provenance is feature-detected off the full record.
  const fullRecords = useHqWorkItems(assistantId);
  const fullById = useMemo(() => {
    const m = new Map<string, HqWorkItem>();
    for (const it of fullRecords.items) m.set(it.id, it);
    return m;
  }, [fullRecords.items]);
  const { projects } = useProjects(assistantId);
  const projectTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, `${p.emoji ?? "📁"} ${p.title}`);
    return m;
  }, [projects]);
  const plainTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.title);
    return m;
  }, [projects]);

  // Frame D3 — hover ✕ → archive + the ink undo pill (⌘Z).
  const { dismiss, gone, leavingId, pillNode } = useDesktopDismiss(assistantId);
  // Frame D2 — the ✨ pill's "Move ›" popover (one row at a time).
  const [refileId, setRefileId] = useState<string | null>(null);
  const [newProjFor, setNewProjFor] = useState<string | null>(null);
  const patch = usePatchWorkItem(assistantId);

  const refileTargets = useMemo(
    () =>
      projects
        .filter((p) => p.status === "active")
        .map((p) => ({ id: p.id, title: p.title, emoji: p.emoji ?? null })),
    [projects],
  );

  const moveTo = (itemId: string, projectId: string) => {
    const full = fullById.get(itemId);
    if (!full) return;
    patch.mutate(
      {
        path: { assistant_id: assistantId, id: itemId },
        body: fullPatchBody(full, { projectId }),
      },
      { onSuccess: () => setRefileId(null) },
    );
  };

  const items = useMemo(
    () =>
      all.items.filter(
        (i) =>
          i.status !== "archived" &&
          i.status !== "cancelled" &&
          !gone.has(i.id),
      ),
    [all.items, gone],
  );

  const groups = useMemo(() => {
    const map = new Map<string, WorkItemView[]>();
    for (const item of items) {
      const key =
        grouping === "status"
          ? (STATUS_LABEL[item.status] ?? item.status)
          : grouping === "thing"
            ? (item.projectId && projectTitle.get(item.projectId)) ||
              UNFILED_LABEL
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
              a === UNFILED_LABEL
                ? 1
                : b === UNFILED_LABEL
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
      <FilingKitStyle />
      <div
        style={{ maxWidth: 880, margin: "0 auto", padding: "34px 22px 60px" }}
      >
        {/* The way back to Things. Without it Everything would be a one-way
            door, which is how the old "All work" ended up feeling like a
            separate place in the first place. */}
        <div style={{ marginBottom: 16 }}>
          <WorkViewTabs current="everything" />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <GroupHeader
            kicker="Work"
            title="Everything, one list."
            accent={C.violet}
            hint="Every live task Cue is tracking, however it arrived."
          />
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              paddingBottom: 18,
            }}
          >
            {/* Frame D1's visible entry — same door as ⌘⇧A anywhere. */}
            <button
              type="button"
              onClick={openAddTasks}
              title="Add tasks (⌘⇧A)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12,
                fontWeight: 500,
                color: C.blueS,
                background: C.blueW,
                border: `1px solid color-mix(in srgb, ${C.blue} 24%, transparent)`,
                borderRadius: 9,
                padding: "5px 11px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ＋ Add tasks
              <span
                aria-hidden
                style={{ fontFamily: mono, fontSize: 9.5, opacity: 0.7 }}
              >
                ⌘⇧A
              </span>
            </button>
            <div
              role="radiogroup"
              aria-label="Group by"
              data-coach="work-view"
              style={{ display: "inline-flex", gap: 4 }}
            >
              {(["status", "thing", "due"] as const).map((g) => (
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
              {group.items.slice(0, 20).map((item, i) => {
                const full = fullById.get(item.id) ?? null;
                const autoFiled =
                  full != null && item.projectId != null && isAutoFiled(full);
                // Does this record actually know anything about where it came
                // from? Nothing known → no pill, no empty line, no guess.
                const hasProvenance =
                  full != null && describeProvenance(full).lines.length > 0;
                const refiling = refileId === item.id;
                return (
                  <div
                    key={item.id}
                    data-filing-row
                    style={{
                      position: "relative",
                      ...dismissLeave(leavingId === item.id),
                    }}
                  >
                    <ActivityRow
                      dotColor={
                        item.status === "done"
                          ? C.green
                          : item.status === "running"
                            ? C.blue
                            : C.amber
                      }
                      title={item.title}
                      // A held task explains itself in the assessor's own
                      // words; every other row keeps its usual second line.
                      subtitle={holdReason(full)}
                      // Why is this here, and what did Cue do to it — one
                      // click, in words. The emptiness test runs at the call
                      // site rather than being left to the component: an
                      // element that renders null is still truthy, so passing
                      // one unconditionally would suppress the legacy chip
                      // AND leave an empty line behind. An item with nothing
                      // to say falls through to `provenance` below, and if
                      // that is null too the row shows neither — which is the
                      // point.
                      provenanceNode={
                        hasProvenance ? (
                          <ProvenanceTrace
                            item={full}
                            projectTitle={
                              item.projectId
                                ? (plainTitle.get(item.projectId) ?? null)
                                : null
                            }
                            onOpenConversation={(cid) =>
                              navigate(routes.conversation(cid))
                            }
                          />
                        ) : null
                      }
                      provenance={item.provenance}
                      meta={
                        // The ✨ pill already names the destination.
                        item.projectId && !autoFiled
                          ? (projectTitle.get(item.projectId) ?? null)
                          : null
                      }
                      // NOT `item.status.replace("_", " ")` — that shipped the
                      // database value to the user, which is how "AWAITING
                      // REVIEW" and "QUEUED" ended up on screen.
                      statusLabel={describeWorkState(item.status).label}
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
                      actions={
                        <>
                          {/* Parked by the pre-run assessment: this row is
                              waiting on a person, not on Cue. */}
                          <AssessmentSignal item={full} />
                          {autoFiled && item.projectId ? (
                            // Frame D2 — provenance said out loud, Move › on
                            // hover.
                            <AutoFiledPill
                              projectTitle={
                                plainTitle.get(item.projectId) ?? "project"
                              }
                              onMove={() =>
                                setRefileId(refiling ? null : item.id)
                              }
                            />
                          ) : null}
                          <DueChip dueAt={item.dueAt} status={item.status} />
                          {full ? (
                            // Frame D3 — hover ✕ archives (undo pill + ⌘Z).
                            <HoverX
                              title={item.title}
                              onDismiss={() => dismiss(full)}
                            />
                          ) : null}
                        </>
                      }
                    />
                    {refiling ? (
                      <RefilePopover
                        targets={refileTargets}
                        currentId={item.projectId}
                        busy={patch.isPending}
                        onPick={(pid) => moveTo(item.id, pid)}
                        onNew={() => {
                          setNewProjFor(item.id);
                          setRefileId(null);
                        }}
                        onClose={() => setRefileId(null)}
                        style={{
                          position: "absolute",
                          top: "calc(100% + 8px)",
                          right: 12,
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </GroupBlock>
          ))
        )}
      </div>

      {pillNode}

      {/* ＋ New project from the refile popover — the fresh project becomes
          the item's home. */}
      {newProjFor !== null ? (
        <NewProjectModal
          assistantId={assistantId}
          onClose={() => setNewProjFor(null)}
          onCreated={(projectId) => {
            const itemId = newProjFor;
            setNewProjFor(null);
            if (itemId) moveTo(itemId, projectId);
          }}
        />
      ) : null}
    </div>
  );
}
