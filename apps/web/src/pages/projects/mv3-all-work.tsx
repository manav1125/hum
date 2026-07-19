/**
 * Mv3AllWork — the mobile v3 rendering of `/assistant/work` (parity audit §3
 * P0: the All-Work list with the desktop group-by). Replaces the MOBILE
 * rendering only; desktop keeps `all-work-page.tsx`'s Activity-language list.
 *
 * Grouping is the SAME client-side toggle desktop uses (status / project /
 * due over one fetch) — the status order, labels and due buckets mirror
 * `all-work-page.tsx` exactly. Rows push to the item's natural surface:
 * running → Watch live, awaiting review → the review pager, everything else →
 * the Mv3TaskSheet (due date / labels / re-file / Run-Redo).
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useActivitySync } from "@/hooks/use-activity-sync";
import {
  AuroraBackdrop,
  LargeTitleHeader,
  StateChip,
  cardBody,
  microLabel,
  mv3Mono,
  rise,
  type Mv3State,
} from "@/mobile-v3";
import { dueLabel } from "@/mobile-v3/work-kit";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { Mv3TaskSheet } from "./mv3-task-sheet";
import { useProjects } from "./use-projects";

type Grouping = "status" | "project" | "due";

/* Desktop's grouping vocabulary, verbatim (all-work-page.tsx). */
const STATUS_ORDER = ["awaiting_review", "running", "queued", "done", "failed"];
const STATUS_LABEL: Record<string, string> = {
  awaiting_review: "Review",
  running: "In motion",
  queued: "Queued",
  done: "Done",
  failed: "Failed",
};

function dueBucket(item: HqWorkItem, now: number): string {
  if (item.dueAt == null) return "No date";
  const d = item.dueAt - now;
  if (d < 0) return "Overdue";
  if (d < 86_400_000) return "Today";
  if (d < 7 * 86_400_000) return "This week";
  return "Later";
}

const DUE_ORDER = ["Overdue", "Today", "This week", "Later", "No date"];

function stateFor(status: string): Mv3State {
  switch (status) {
    case "running":
      return "running";
    case "awaiting_review":
      return "review";
    case "done":
      return "done";
    case "failed":
      return "needs_you";
    default:
      return "picked_up";
  }
}

function WorkRow({
  item,
  projectName,
  now,
  delay,
  onOpen,
}: {
  item: HqWorkItem;
  projectName: string | null;
  now: number;
  delay: number;
  onOpen: () => void;
}) {
  return (
    <div
      data-mv3
      role="button"
      tabIndex={0}
      className="cue-pressable"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderRadius: 16,
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 11,
        minHeight: 52,
        cursor: "pointer",
        ...rise(delay),
      }}
    >
      <StateChip state={stateFor(item.status)} label="" size="sm" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--mv3-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </div>
        {projectName ? (
          <div
            style={{
              fontSize: 11,
              color: "var(--mv3-faint)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {projectName}
          </div>
        ) : null}
      </div>
      {item.dueAt != null ? (
        <span
          style={{
            fontFamily: mv3Mono,
            fontSize: 9,
            color: "var(--mv3-amber)",
            background: "color-mix(in srgb, var(--mv3-amber) 15%, transparent)",
            padding: "3px 8px",
            borderRadius: 6,
            letterSpacing: "0.08em",
            flexShrink: 0,
          }}
        >
          {dueLabel(item.dueAt, now)}
        </span>
      ) : null}
      <span aria-hidden style={{ fontSize: 15, color: "var(--mv3-faint)" }}>
        ›
      </span>
    </div>
  );
}

export function Mv3AllWork() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [grouping, setGrouping] = useState<Grouping>("status");
  // Stable reference time (purity rule: no Date.now() in render).
  const [now] = useState(() => Date.now());
  const [sheetItemId, setSheetItemId] = useState<string | null>(null);

  // Full records (the typed hq bucket) so the sheet can assemble the daemon's
  // full-record PATCH body straight off the row it opened from.
  const all = useHqWorkItems(assistantId);
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

  // Desktop's grouping logic, verbatim.
  const groups = useMemo(() => {
    const map = new Map<string, HqWorkItem[]>();
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

  const sheetItem = useMemo(
    () => items.find((i) => i.id === sheetItemId) ?? null,
    [items, sheetItemId],
  );

  // Rows push to the item's natural surface; the sheet is the edit door.
  const openItem = (item: HqWorkItem) => {
    haptic.light();
    if (item.status === "running") navigate(routes.workLive(item.id));
    else if (item.status === "awaiting_review") navigate(routes.reviewQueue);
    else setSheetItemId(item.id);
  };

  let slot = 0;
  const nextDelay = () => 0.08 + 0.05 * Math.min(slot++, 8);

  return (
    <div
      data-mv3
      data-slot="mv3-all-work"
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />
      <LargeTitleHeader title="All work" scrollRef={scrollRef} />

      {/* Group-by segment pills — the desktop toggle, in v3 grammar. */}
      <div
        role="radiogroup"
        aria-label="Group by"
        style={{
          display: "flex",
          gap: 7,
          padding: "10px 22px 10px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        {(
          [
            { key: "status", label: "Status" },
            { key: "project", label: "Project" },
            { key: "due", label: "Due" },
          ] as const
        ).map((g) => {
          const selected = grouping === g.key;
          return (
            <button
              key={g.key}
              type="button"
              role="radio"
              aria-checked={selected}
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                setGrouping(g.key);
              }}
              style={{
                fontSize: 12.5,
                fontWeight: selected ? 600 : 400,
                color: selected ? "var(--mv3-bg)" : "var(--mv3-muted)",
                background: selected ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
                border: selected
                  ? "1px solid transparent"
                  : "1px solid var(--mv3-btn2-border)",
                borderRadius: 99,
                padding: "7px 15px",
                minHeight: 34,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {g.label}
            </button>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "2px 16px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
        {all.isLoading ? (
          <div style={{ ...cardBody, padding: "8px 6px" }}>
            Loading your work…
          </div>
        ) : items.length === 0 ? (
          <div style={{ ...cardBody, padding: "8px 6px" }}>
            Nothing live right now — captured work shows up here the moment it
            lands.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} style={{ marginBottom: 18 }}>
              <div
                style={{
                  ...microLabel,
                  fontSize: 9.5,
                  letterSpacing: "0.1em",
                  color: "var(--mv3-faint)",
                  padding: "4px 6px 8px",
                }}
              >
                {group.key} · {group.items.length}
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                {group.items.slice(0, 20).map((item) => (
                  <WorkRow
                    key={item.id}
                    item={item}
                    projectName={
                      grouping !== "project" && item.projectId
                        ? (projectTitle.get(item.projectId) ?? null)
                        : null
                    }
                    now={now}
                    delay={nextDelay()}
                    onOpen={() => openItem(item)}
                  />
                ))}
                {group.items.length > 20 ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--mv3-faint)",
                      padding: "2px 6px",
                    }}
                  >
                    +{group.items.length - 20} more
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <Mv3TaskSheet
        assistantId={assistantId}
        item={sheetItem}
        projects={projects}
        onClose={() => setSheetItemId(null)}
      />
    </div>
  );
}
