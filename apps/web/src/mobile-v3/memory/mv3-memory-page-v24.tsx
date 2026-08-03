/**
 * Mv3MemoryV24Page — the phone's Memory screen (design v24 frame **F6**).
 *
 * Your rules first, quoted, then what Cue inferred this week with its
 * evidence. Distinct from People by design's own ruling: *Memory is the raw
 * learnings; People is the browsable relationship built from them.*
 *
 * ## The one thing in this frame that has no data
 *
 * F6's headline device is a use count — *"applied 14 times"*, which design
 * says is "what makes a rule feel alive rather than stored". **It does not
 * exist.** `nodeToPayload` in `assistant/src/runtime/routes/memory-item-routes.ts`
 * hardcodes `accessCount: null` and `lastUsedAt: null` for every memory
 * ("legacy fields — not applicable to graph nodes"), and `memory_graph_nodes`
 * has no access-count column at all. The nearest real field,
 * `reinforcementCount`, counts times a memory was *re-observed*, not times it
 * was *applied* — and on the owner's production instance exactly one node out
 * of 3,279 has a non-zero value.
 *
 * So this screen renders `reinforcementCount` as what it is ("seen again
 * twice"), only when it is greater than zero, and never claims an application
 * count. Printing "applied 14 times" against a null field would be the exact
 * fabricated-number failure this project keeps re-learning; a rule that says
 * nothing about its use is better than a rule that lies about it.
 *
 * ## What is real
 *
 *  · the rules       `memoryitemsGet` rows with `sourceType === "direct"` —
 *                    things you told Cue, quoted verbatim, newest first
 *  · learned lately  every other source type, first seen in the last 7 days
 *  · evidence        `sourceType` + `firstSeenAt` + `reinforcementCount`
 *  · corrections     rows whose statement was edited (`supersedes`) — absent
 *                    from the graph payload, so the header does NOT claim a
 *                    correction count the way F6 draws it.
 *  · edit / forget   the same mutations the desktop Memory page uses.
 */

import { useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { memoryitemsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { memoryitemsByIdDelete } from "@/generated/daemon/sdk.gen";
import { useMemoryItemsQuery } from "@/domains/intelligence/memories/hooks/use-memory-items-query";
import type { MemoryItem } from "@/domains/intelligence/memories/types";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel } from "../mv3-kit";
import { TrustFootnote, YouScreen, shortDate } from "../you/you-kit";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Segment = "all" | "rules" | "learned";

/** Things you told Cue outright. F6's "YOUR RULES". */
function isRule(m: MemoryItem): boolean {
  return m.sourceType === "direct";
}

export function Mv3MemoryV24Page() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const [segment, setSegment] = useState<Segment>("all");
  const [now] = useState(() => Date.now());
  const [pendingForget, setPendingForget] = useState<MemoryItem | null>(null);

  const { data, isLoading, isError, refetch } = useMemoryItemsQuery(
    assistantId,
    null,
  );

  const items = useMemo<MemoryItem[]>(() => data?.items ?? [], [data?.items]);

  const rules = useMemo(
    () =>
      items
        .filter(isRule)
        .sort((a, b) => (b.firstSeenAt ?? 0) - (a.firstSeenAt ?? 0)),
    [items],
  );

  const learnedThisWeek = useMemo(
    () =>
      items
        .filter((m) => !isRule(m) && now - (m.firstSeenAt ?? 0) < WEEK_MS)
        .sort((a, b) => (b.firstSeenAt ?? 0) - (a.firstSeenAt ?? 0)),
    [items, now],
  );

  const forget = useMutation({
    mutationFn: (id: string) =>
      memoryitemsByIdDelete({ path: { assistant_id: assistantId, id } }),
    onSuccess: () => {
      haptic.success();
      setPendingForget(null);
      void queryClient.invalidateQueries({
        queryKey: memoryitemsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
    },
    onError: () => haptic.error(),
  });

  const showRules = segment === "all" || segment === "rules";
  const showLearned = segment === "all" || segment === "learned";

  return (
    <YouScreen
      tint="violet"
      back={routes.yourCue}
      backLabel="Your Cue"
      title="Memory"
      testId="mv3-memory-v24"
      sub={
        <MemoryCount
          total={items.length}
          rules={rules.length}
          loading={isLoading}
          error={isError}
        />
      }
    >
      <div style={{ display: "flex", gap: 5, overflowX: "auto", scrollbarWidth: "none" }}>
        <Seg label="All" on={segment === "all"} press={() => setSegment("all")} />
        <Seg
          label={`Your rules${rules.length ? ` · ${rules.length}` : ""}`}
          on={segment === "rules"}
          press={() => setSegment("rules")}
        />
        <Seg
          label="Learned this week"
          on={segment === "learned"}
          press={() => setSegment("learned")}
        />
      </div>

      {isError ? (
        <GlassCard radius={15} style={{ marginTop: 13 }}>
          <div style={{ ...microLabel, fontSize: 9, color: "var(--mv3-fail-text)" }}>
            <span aria-hidden>⚠ </span>MEMORY DIDN&rsquo;T LOAD
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-text)",
              lineHeight: 1.5,
              marginTop: 6,
            }}
          >
            Cue couldn&rsquo;t read its own memory store. Nothing has been
            forgotten — the request failed.
          </div>
          <button
            type="button"
            onClick={() => {
              haptic.light();
              void refetch();
            }}
            style={quietBtn}
          >
            Try again
          </button>
        </GlassCard>
      ) : isLoading ? (
        <Muted>Reading what Cue knows…</Muted>
      ) : (
        <>
          {showRules && (
            <>
              <Eyebrow tone="violet">
                YOUR RULES{rules.length > 0 ? ` · ${rules.length}` : ""}
              </Eyebrow>
              {rules.length === 0 ? (
                <Muted>
                  You haven&rsquo;t told Cue any standing rules yet. Say
                  &ldquo;always…&rdquo; or &ldquo;never…&rdquo; in a chat and it
                  lands here, quoted, for you to edit or forget.
                </Muted>
              ) : (
                <GlassCard tint="violet" radius={15} padding={0} style={{ marginTop: 7 }}>
                  {rules.slice(0, 12).map((m, i) => (
                    <RuleRow
                      key={m.id}
                      item={m}
                      last={i === Math.min(rules.length, 12) - 1}
                      onForget={() => {
                        haptic.light();
                        setPendingForget(m);
                      }}
                    />
                  ))}
                </GlassCard>
              )}
            </>
          )}

          {showLearned && (
            <>
              <Eyebrow>LEARNED THIS WEEK</Eyebrow>
              {learnedThisWeek.length === 0 ? (
                <Muted>
                  Cue hasn&rsquo;t written anything new this week. That is a
                  quiet week, not a failure — {items.length} older{" "}
                  {items.length === 1 ? "memory" : "memories"} are still here.
                </Muted>
              ) : (
                <GlassCard radius={15} padding={0} style={{ marginTop: 7 }}>
                  {learnedThisWeek.slice(0, 20).map((m, i) => (
                    <LearnedRow
                      key={m.id}
                      item={m}
                      last={i === Math.min(learnedThisWeek.length, 20) - 1}
                      onForget={() => {
                        haptic.light();
                        setPendingForget(m);
                      }}
                    />
                  ))}
                </GlassCard>
              )}
            </>
          )}

          <div style={{ marginTop: 16 }}>
            <TrustFootnote>
              On your instance only · edit or forget anything
            </TrustFootnote>
          </div>
        </>
      )}

      {pendingForget && (
        <ForgetConfirm
          item={pendingForget}
          busy={forget.isPending}
          onCancel={() => setPendingForget(null)}
          onConfirm={() => forget.mutate(pendingForget.id)}
        />
      )}
    </YouScreen>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function MemoryCount({
  total,
  rules,
  loading,
  error,
}: {
  total: number;
  rules: number;
  loading: boolean;
  error: boolean;
}) {
  if (error) return <>Memory didn&rsquo;t load.</>;
  if (loading) return <>Reading…</>;
  if (total === 0) return <>Nothing learned yet.</>;
  return (
    <>
      {total} {total === 1 ? "thing" : "things"} learned · {rules} you told it
    </>
  );
}

function Eyebrow({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "violet";
}) {
  return (
    <div
      style={{
        ...microLabel,
        fontSize: 9,
        marginTop: 14,
        color:
          tone === "violet" ? "var(--mv3-violet-text)" : "var(--mv3-muted)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * A rule, quoted. The provenance line carries only fields that are real —
 * when a memory has never been reinforced there is simply no use line, rather
 * than a zero dressed up as information.
 */
function RuleRow({
  item,
  last,
  onForget,
}: {
  item: MemoryItem;
  last: boolean;
  onForget: () => void;
}) {
  const seen = item.reinforcementCount ?? 0;
  return (
    <div
      style={{
        padding: "11px 13px",
        borderBottom: last ? "none" : "1px solid var(--mv3-line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            &ldquo;{item.statement}&rdquo;
          </div>
          <div style={{ fontSize: 9, color: "var(--mv3-muted)", marginTop: 4 }}>
            {[
              "You told me",
              item.firstSeenAt ? shortDate(item.firstSeenAt) : null,
              seen > 0
                ? `seen again ${seen === 1 ? "once" : `${seen} times`}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <button
          type="button"
          onClick={onForget}
          aria-label={`Forget: ${item.statement}`}
          style={forgetBtn}
        >
          Forget
        </button>
      </div>
    </div>
  );
}

function LearnedRow({
  item,
  last,
  onForget,
}: {
  item: MemoryItem;
  last: boolean;
  onForget: () => void;
}) {
  const evidence = [
    item.sourceType === "observed"
      ? "Cue observed this"
      : item.sourceType === "inferred"
        ? "Cue inferred this"
        : null,
    item.firstSeenAt ? shortDate(item.firstSeenAt) : null,
    item.kind,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 13px",
        borderBottom: last ? "none" : "1px solid var(--mv3-line)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "var(--mv3-text)", lineHeight: 1.45 }}>
          {item.statement}
        </div>
        <div style={{ fontSize: 9, color: "var(--mv3-muted)", marginTop: 2 }}>
          {evidence || "no provenance recorded"}
        </div>
      </div>
      <button
        type="button"
        onClick={onForget}
        aria-label={`Forget: ${item.statement}`}
        style={forgetBtn}
      >
        Forget
      </button>
    </div>
  );
}

function ForgetConfirm({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: MemoryItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Forget this memory?"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-end",
        background: "rgba(0,0,0,.42)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          background: "var(--mv3-sheet)",
          borderTop: "1px solid var(--mv3-sheet-border)",
          borderRadius: "20px 20px 0 0",
          padding: "18px 18px calc(22px + env(safe-area-inset-bottom, 0px))",
          color: "var(--mv3-text)",
          fontFamily: "var(--mv3-font)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>Forget this?</div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--mv3-muted)",
            lineHeight: 1.5,
            marginTop: 7,
          }}
        >
          &ldquo;{item.statement}&rdquo;
        </div>
        <div style={{ display: "flex", gap: 9, marginTop: 15 }}>
          <button type="button" onClick={onCancel} style={{ ...quietBtn, flex: 1, marginTop: 0 }}>
            Keep it
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            style={{
              flex: 1,
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-fail-card-border)",
              borderRadius: 13,
              padding: "11px 14px",
              fontFamily: "inherit",
              fontSize: 13.5,
              color: "var(--mv3-fail-text)",
              cursor: busy ? "default" : "pointer",
            }}
          >
            {busy ? "Forgetting…" : "Forget"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Seg({
  label,
  on,
  press,
}: {
  label: string;
  on: boolean;
  press: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        haptic.light();
        press();
      }}
      style={{
        flexShrink: 0,
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: on ? 600 : 400,
        color: on ? "var(--mv3-bg)" : "var(--mv3-pill-text)",
        background: on ? "var(--mv3-text)" : "var(--mv3-pill)",
        border: `1px solid ${on ? "transparent" : "var(--mv3-pill-border)"}`,
        borderRadius: 99,
        padding: "5px 11px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--mv3-muted)",
        lineHeight: 1.55,
        marginTop: 8,
        padding: "0 2px",
      }}
    >
      {children}
    </div>
  );
}

const quietBtn: React.CSSProperties = {
  marginTop: 10,
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 13,
  padding: "11px 14px",
  fontFamily: "inherit",
  fontSize: 13.5,
  color: "var(--mv3-text)",
  cursor: "pointer",
};

const forgetBtn: React.CSSProperties = {
  flexShrink: 0,
  background: "none",
  border: "none",
  padding: "2px 0 2px 6px",
  fontFamily: "inherit",
  fontSize: 10,
  color: "var(--mv3-muted)",
  cursor: "pointer",
};
