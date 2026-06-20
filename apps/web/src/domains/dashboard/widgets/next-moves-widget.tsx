/**
 * Next-moves widget — REAL data via `useHomeFeedQuery`.
 *
 * Shows the top few ranked feed items (title · urgency dot · category) with
 * each item's own real action button (triggerAction →
 * homeFeedByIdActionsByActionIdPost) plus dismiss (updateStatus → patch).
 * Accepts an optional `categories` slice so templates can scope the feed
 * (Company = background/system; Personal = all).
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";

import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
import { sortFeedItems } from "@/domains/home/utils";

import { C } from "../theme";
import type { FeedCategory } from "../templates";
import { Dot, WidgetFrame } from "./widget-frame";

const MAX_ROWS = 4;

function urgencyColor(urgency: string | undefined): string {
  if (urgency === "critical" || urgency === "high") return C.danger;
  if (urgency === "medium") return C.amber;
  return C.line2;
}

export function NextMovesWidget({
  assistantId,
  categories,
}: {
  assistantId: string;
  categories?: FeedCategory[];
}) {
  const feed = useHomeFeedQuery(assistantId);
  const navigate = useNavigate();

  const items = useMemo(() => {
    const all = feed.data?.items ?? [];
    const live = all.filter((i) => i.status !== "dismissed");
    const sliced = categories
      ? live.filter((i) => i.category && categories.includes(i.category))
      : live;
    return sortFeedItems(sliced).slice(0, MAX_ROWS);
  }, [feed.data?.items, categories]);

  const pending = feed.triggerAction.isPending || feed.updateStatus.isPending;

  return (
    <WidgetFrame
      title="Next moves"
      action={
        <button
          type="button"
          onClick={() => navigate("/assistant/next-moves")}
          style={ghost}
        >
          See all
        </button>
      }
      loading={feed.isLoading}
      loadingLabel="Gathering your next moves…"
      error={feed.isError}
      empty={!feed.isLoading && !feed.isError && items.length === 0}
      emptyLabel="You’re all caught up — Cue surfaces what needs you here."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((item) => {
          const title = item.title ?? item.summary;
          const action = item.actions?.[0];
          return (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 0",
                borderBottom: `1px solid ${C.line}`,
              }}
            >
              <Dot color={urgencyColor(item.urgency)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: C.t1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {title}
                </div>
                {item.category ? (
                  <div style={{ fontSize: 11, color: C.t3 }}>
                    {item.category}
                  </div>
                ) : null}
              </div>
              {action ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    feed.triggerAction.mutate({
                      itemId: item.id,
                      actionId: action.id,
                    })
                  }
                  style={primary(pending)}
                >
                  {action.label}
                </button>
              ) : null}
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  feed.updateStatus.mutate({
                    itemId: item.id,
                    status: "dismissed",
                  })
                }
                style={ghost}
              >
                Dismiss
              </button>
            </div>
          );
        })}
      </div>
    </WidgetFrame>
  );
}

const ghost = {
  fontSize: 12,
  fontWeight: 500,
  border: "1px solid transparent",
  background: "transparent",
  color: C.t2,
  borderRadius: 8,
  padding: "4px 8px",
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;

function primary(disabled: boolean) {
  return {
    fontSize: 12,
    fontWeight: 500,
    border: `1px solid ${C.blue}`,
    background: C.blue,
    color: "#fff",
    borderRadius: 8,
    padding: "4px 10px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
    whiteSpace: "nowrap",
  } as const;
}
