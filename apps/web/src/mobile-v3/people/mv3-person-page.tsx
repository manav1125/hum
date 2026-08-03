/**
 * Mv3PersonPage — the phone's "a person" screen (design v24 frame **F4**).
 *
 * The compounding surface at person scale: what Cue has learned in prose with
 * its provenance, the relationship state as a chip, open items on both sides,
 * and the last exchange.
 *
 * ## Where this differs from the frame, and why
 *
 * Three things F4 draws are not in the daemon, and each is handled by saying
 * less rather than by inventing:
 *
 * 1. **"You owe a reply"** as the header chip. No interaction carries a
 *    direction, so the chip shows only what `people-data.ts` can derive.
 *
 * 2. **"TOGETHER" — open items on both sides.** The only link between a work
 *    item and a person in the whole API is `workItem.assignee`, a *name
 *    string* ("cue" | "you" | contact name). So this section matches items by
 *    display name, and when nothing matches it says that the link doesn't
 *    exist rather than implying a clear plate. On the owner's instance today
 *    every one of 407 work items is assigned to `cue` or nobody, so this
 *    section will render its empty sentence for every person.
 *
 * 3. **"the last thing they actually said"** — a quoted message body. The
 *    dossier's `interactions[]` carries the conversation, its channel and its
 *    timestamp, and no endpoint returns the message text. So this renders the
 *    exchange as what it is — thread, channel, when, tappable — and never a
 *    quotation. A fabricated quote attributed to a real person is the worst
 *    thing on this screen's risk list.
 *
 * Everything else is real: the memory statements, the exchange count, the last
 * contact time, the channels, the timeline.
 */

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { postChatMessage } from "@/domains/chat/api/messages";
import {
  contactsByIdDossierGetOptions,
  peopleMemoryHealthGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ContactsByIdDossierGetResponse } from "@/generated/daemon/types.gen";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel } from "../mv3-kit";
import { YouScreen } from "../you/you-kit";
import { Avatar } from "./mv3-people-page";
import {
  compactAgo,
  learnedSummary,
  relationshipState,
  toMs,
  type LearnedSummary,
} from "./people-data";

type Dossier = Extract<
  ContactsByIdDossierGetResponse,
  { dossier: unknown }
>["dossier"];

/** Work-item statuses that mean "still open". */
const OPEN_STATUSES = new Set([
  "todo",
  "in_progress",
  "running",
  "awaiting_review",
  "blocked",
  "queued",
]);

export function Mv3PersonPage() {
  const assistantId = useActiveAssistantId();
  const { contactId = "" } = useParams();
  const navigate = useNavigate();
  const [now] = useState(() => Date.now());

  const dossierQuery = useQuery({
    ...contactsByIdDossierGetOptions({
      path: { assistant_id: assistantId, id: contactId },
    }),
    enabled: Boolean(assistantId && contactId),
  });

  const healthQuery = useQuery({
    ...peopleMemoryHealthGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    retry: false,
  });

  const dossier = dossierQuery.data?.dossier as Dossier | undefined;
  const name = dossier?.displayName ?? "";

  const workQuery = useQuery({
    ...workitemsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId && name),
  });

  const summary = useMemo<LearnedSummary>(
    () =>
      learnedSummary({
        isLoading: dossierQuery.isLoading,
        isError: dossierQuery.isError,
        memory: dossier?.memory,
        degraded: healthQuery.isError ? undefined : healthQuery.data?.degraded,
        degradedReason: healthQuery.data?.degradedReason,
        interactionCount: dossier?.relationship.interactionCount ?? 0,
        displayName: name || "them",
      }),
    [
      dossierQuery.isLoading,
      dossierQuery.isError,
      dossier?.memory,
      dossier?.relationship.interactionCount,
      healthQuery.data?.degraded,
      healthQuery.data?.degradedReason,
      healthQuery.isError,
      name,
    ],
  );

  /**
   * Items that name this person. `assignee` is the only person link in the
   * API and it is a display-name string, so an exact trimmed match is the
   * most this can honestly claim.
   */
  const theirItems = useMemo(() => {
    if (!name) return [];
    const target = name.trim().toLowerCase();
    return (workQuery.data?.items ?? []).filter(
      (i) =>
        (i.assignee ?? "").trim().toLowerCase() === target &&
        OPEN_STATUSES.has(i.status),
    );
  }, [workQuery.data?.items, name]);

  const first = name.trim().split(/\s+/)[0] || "them";
  const state = dossier
    ? relationshipState(
        {
          lastInteraction: dossier.relationship.lastInteractionAt,
          interactionCount: dossier.relationship.interactionCount,
        },
        now,
      )
    : null;

  async function ask() {
    haptic.medium();
    const intent =
      (dossier?.relationship.interactionCount ?? 0) > 0
        ? `What's the latest with ${name}?`
        : `Draft a message to ${name}.`;
    const result = await postChatMessage(assistantId, null, intent);
    if (result.ok) void navigate(routes.conversation(result.conversationId));
  }

  // A failed dossier read is its own screen — never an empty person.
  if (dossierQuery.isError) {
    return (
      <YouScreen tint="blue" back={routes.people} backLabel="People">
        <GlassCard radius={16}>
          <div style={{ ...microLabel, fontSize: 9, color: "var(--mv3-fail-text)" }}>
            <span aria-hidden>⚠ </span>COULDN&rsquo;T LOAD THIS PERSON
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--mv3-text)",
              lineHeight: 1.5,
              marginTop: 7,
            }}
          >
            Cue couldn&rsquo;t read its dossier for this contact. Nothing has
            been forgotten — the request failed.
          </div>
          <button
            type="button"
            onClick={() => {
              haptic.light();
              void dossierQuery.refetch();
            }}
            style={retryBtn}
          >
            Try again
          </button>
        </GlassCard>
      </YouScreen>
    );
  }

  if (dossierQuery.isLoading || !dossier) {
    return (
      <YouScreen tint="blue" back={routes.people} backLabel="People">
        <div style={{ fontSize: 13, color: "var(--mv3-muted)", padding: "8px 2px" }}>
          Loading…
        </div>
      </YouScreen>
    );
  }

  const ago = compactAgo(dossier.relationship.lastInteractionAt, now);
  const lastExchange = dossier.interactions[0] ?? null;

  return (
    <YouScreen
      tint="blue"
      back={routes.people}
      backLabel="People"
      testId="mv3-person"
      header={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "0 2px 4px",
          }}
        >
          <Avatar name={dossier.displayName} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.4px" }}
            >
              {dossier.displayName}
            </div>
            <div
              style={{ fontSize: 11, color: "var(--mv3-muted)", marginTop: 1 }}
            >
              {[dossier.contactType, dossier.role]
                .filter((v) => v && v !== "contact" && v !== "human")
                .join(" · ") || "contact"}
            </div>
          </div>
          {state && (
            <span
              style={{
                flexShrink: 0,
                fontSize: 10.5,
                fontWeight: state.tone === "warn" ? 600 : 400,
                color:
                  state.tone === "warn"
                    ? "var(--mv3-amber-text)"
                    : "var(--mv3-muted)",
                background:
                  state.tone === "warn"
                    ? "var(--mv3-amber-card-bg)"
                    : "var(--mv3-pill)",
                border: `1px solid ${
                  state.tone === "warn"
                    ? "var(--mv3-amber-card-border)"
                    : "var(--mv3-pill-border)"
                }`,
                borderRadius: 99,
                padding: "4px 9px",
              }}
            >
              {state.label}
            </span>
          )}
        </div>
      }
    >
      {/* ── What Cue has learned ─────────────────────────────────────── */}
      <GlassCard radius={15} padding="12px 14px">
        <div style={{ ...microLabel, fontSize: 9, color: "var(--mv3-muted)" }}>
          WHAT CUE HAS LEARNED
        </div>
        <LearnedBody summary={summary} />
      </GlassCard>

      {/* ── The three real numbers ───────────────────────────────────── */}
      <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
        <Stat
          value={String(dossier.relationship.interactionCount)}
          label="exchanges"
        />
        <Stat value={ago ?? "—"} label="last contact" />
        <Stat
          value={workQuery.isError ? "—" : String(theirItems.length)}
          label={workQuery.isError ? "items unread" : "items named to them"}
        />
      </div>

      {/* ── Together ─────────────────────────────────────────────────── */}
      <div
        style={{ ...microLabel, fontSize: 9, color: "var(--mv3-muted)", marginTop: 14 }}
      >
        TOGETHER
      </div>
      {workQuery.isError ? (
        <Note tone="fail">
          <span aria-hidden>⚠ </span>Cue couldn&rsquo;t read your work items, so
          this list is unknown rather than empty.
        </Note>
      ) : theirItems.length === 0 ? (
        <Note>
          No open work item names {first}. Cue only links an item to a person
          when it assigns that item to them by name, which it has not done here.
        </Note>
      ) : (
        <GlassCard radius={15} padding={0} style={{ marginTop: 7 }}>
          {theirItems.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                haptic.light();
                // The review pager is how every other mobile surface opens a
                // work item (`review-index-page`); there is no per-item route.
                void navigate(
                  `${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`,
                );
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                borderBottom:
                  i < theirItems.length - 1
                    ? "1px solid var(--mv3-line)"
                    : "none",
                padding: "10px 13px",
                fontFamily: "inherit",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              <span aria-hidden style={{ fontSize: 11, color: "var(--mv3-muted)" }}>
                ○
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 11.5 }}>
                  {item.title}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 9,
                    color: "var(--mv3-muted)",
                  }}
                >
                  assigned to {item.assignee} · {item.status.replace(/_/g, " ")}
                </span>
              </span>
              <span aria-hidden style={{ fontSize: 11, color: "var(--mv3-muted)" }}>
                ›
              </span>
            </button>
          ))}
        </GlassCard>
      )}

      {/* ── Last exchange ────────────────────────────────────────────── */}
      <div
        style={{ ...microLabel, fontSize: 9, color: "var(--mv3-muted)", marginTop: 14 }}
      >
        LAST EXCHANGE
        {lastExchange ? ` · ${compactAgo(lastExchange.at, now) ?? ""} AGO` : ""}
      </div>
      {dossier.interactionsDegraded && (
        <Note tone="warn">
          <span aria-hidden>! </span>The history didn&rsquo;t fully load, so
          what&rsquo;s below may not be the most recent exchange.
        </Note>
      )}
      {lastExchange ? (
        <GlassCard radius={14} padding={0} style={{ marginTop: 7 }}>
          <button
            type="button"
            onClick={() => {
              haptic.light();
              void navigate(routes.conversation(lastExchange.conversationId));
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              padding: "11px 13px",
              fontFamily: "inherit",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            <span style={{ display: "block", fontSize: 11.5, lineHeight: 1.5 }}>
              {lastExchange.title?.trim() || "Untitled thread"}
            </span>
            <span
              style={{
                display: "block",
                fontSize: 9.5,
                color: "var(--mv3-muted)",
                marginTop: 4,
              }}
            >
              {lastExchange.channel} · {fmtDate(lastExchange.at)} · open the
              thread to read it
            </span>
          </button>
        </GlassCard>
      ) : (
        <Note>
          No exchange with {first} has been recorded. Cue lists a thread here
          once it has read one.
        </Note>
      )}

      {/* ── Reachable on ─────────────────────────────────────────────── */}
      {dossier.reachability.length > 0 && (
        <>
          <div
            style={{
              ...microLabel,
              fontSize: 9,
              color: "var(--mv3-muted)",
              marginTop: 14,
            }}
          >
            REACHABLE ON
          </div>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}
          >
            {dossier.reachability.map((ch) => (
              <span
                key={ch.channelId}
                style={{
                  fontSize: 10.5,
                  color: ch.reachable
                    ? "var(--mv3-muted)"
                    : "var(--mv3-fail-text)",
                  background: "var(--mv3-pill)",
                  border: "1px solid var(--mv3-pill-border)",
                  borderRadius: 99,
                  padding: "5px 10px",
                }}
              >
                {ch.reachable ? "" : "⚠ "}
                {ch.type}
                {ch.isPrimary ? " · primary" : ""}
                {ch.reachable ? "" : " · unreachable"}
              </span>
            ))}
          </div>
        </>
      )}

      {/* ── The composer sits in thumb reach, per the reach rule ─────── */}
      <button
        type="button"
        onClick={() => void ask()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: "100%",
          marginTop: 18,
          background: "var(--mv3-glass)",
          border: "1px solid var(--mv3-guide-ring)",
          borderRadius: 19,
          padding: "12px 14px",
          fontFamily: "inherit",
          fontSize: 12.5,
          color: "var(--mv3-muted)",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ flex: 1 }}>Ask about {first}…</span>
        <span aria-hidden style={{ color: "var(--mv3-micro)" }}>
          ◎
        </span>
      </button>
    </YouScreen>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function LearnedBody({ summary }: { summary: LearnedSummary }) {
  if (summary.status === "loading") {
    return <Body color="var(--mv3-muted)">Reading what Cue knows…</Body>;
  }
  if (summary.status === "error") {
    return (
      <Body color="var(--mv3-fail-text)">
        <span aria-hidden>⚠ </span>
        {summary.sentence}
      </Body>
    );
  }
  if (summary.status === "degraded") {
    return (
      <>
        <Body color="var(--mv3-amber-text)">
          <span aria-hidden>! </span>
          {summary.sentence}
        </Body>
        {summary.reason && (
          <div
            style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 8 }}
          >
            {summary.reason}
          </div>
        )}
      </>
    );
  }
  if (summary.status === "empty") {
    return (
      <Body color="var(--mv3-muted)" italic>
        {summary.sentence}
      </Body>
    );
  }
  return (
    <>
      <Body>{summary.prose}</Body>
      {summary.provenance && (
        <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 8 }}>
          {summary.provenance} ·{" "}
          {summary.statements.length}{" "}
          {summary.statements.length === 1 ? "statement" : "statements"}
        </div>
      )}
    </>
  );
}

function Body({
  children,
  color = "var(--mv3-text)",
  italic,
}: {
  children: React.ReactNode;
  color?: string;
  italic?: boolean;
}) {
  return (
    <div
      style={{
        fontSize: 11.5,
        color,
        lineHeight: 1.6,
        fontStyle: italic ? "italic" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div
      style={{
        flex: 1,
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderRadius: 13,
        padding: "10px 11px",
      }}
    >
      <div
        style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </div>
      <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function Note({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "warn" | "fail";
}) {
  const color =
    tone === "fail"
      ? "var(--mv3-fail-text)"
      : tone === "warn"
        ? "var(--mv3-amber-text)"
        : "var(--mv3-muted)";
  return (
    <div
      style={{
        fontSize: 11,
        color,
        lineHeight: 1.5,
        marginTop: 7,
        padding: "0 2px",
      }}
    >
      {children}
    </div>
  );
}

const retryBtn: React.CSSProperties = {
  marginTop: 10,
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 12,
  padding: "8px 14px",
  fontFamily: "inherit",
  fontSize: 12.5,
  color: "var(--mv3-text)",
  cursor: "pointer",
};

function fmtDate(epoch: number): string {
  const ms = toMs(epoch);
  if (ms == null) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
