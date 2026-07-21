/**
 * W4 — Call transcript (desktop HQ, serif grammar).
 *
 * Renders a phone call as an HQ conversation: caller · direction · duration,
 * the caller ↔ Cue-as-receptionist transcript, and the action items the
 * post-call extractor filed into work (typed ↴ action / ◈ decision / ◷
 * context), with Call-back and a jump into the work queue.
 *
 * DATA (all real):
 *  · meta       = `GET /v1/assistants/{id}/calls/{callSessionId}`
 *  · transcript = `GET …/messages?conversationId=…` (the dedicated voice
 *                 conversation's caller + Cue turns)
 *  · items      = `GET …/work-items`, filtered to the ones this call filed
 *                 (`sourceContext.callSessionId === callSessionId`)
 *  · call back  = `POST …/calls/start`
 *
 * HONESTY: decision/context items are extracted in the moment but only action
 * items are persisted as work items today, so this surface shows the filed
 * actions (the ◈/◷ types are marked NEEDS BACKEND where none exist). The
 * transcript + meta render for any finished call; nothing renders that the
 * backend can't stand behind.
 */
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  callsByCallSessionIdGetOptions,
  callsStartPostMutation,
  messagesGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { C, mono, serif } from "@/lib/hq-theme";
import { routes } from "@/utils/routes";

// ── View model ───────────────────────────────────────────────────────────

export type CallItemType = "action" | "decision" | "context";

export interface CallTranscriptTurn {
  speaker: "caller" | "cue";
  text: string;
}

export interface CallExtractedItem {
  id: string;
  type: CallItemType;
  title: string;
  /** The work-item's queue status, when this item is a filed action. */
  status?: string;
  assignee?: string | null;
}

export interface CallView {
  callSessionId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  /** The other party's number (caller for inbound, callee for outbound). */
  counterparty: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  transcript: CallTranscriptTurn[];
  items: CallExtractedItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

const CONTROL_MARKER_RE =
  /\[(?:END_CALL|CALL_OPENING(?:_ACK)?|ASK_GUARDIAN(?:_APPROVAL)?|USER_ANSWERED|USER_INSTRUCTION|SPEAKER[^\]]*)\b[^\]]*\]/g;

/** Strip control markers + collapse whitespace from a spoken line. */
export function cleanSpokenLine(text: string): string {
  return text.replace(CONTROL_MARKER_RE, "").replace(/\s+/g, " ").trim();
}

export function formatDuration(
  startedAt: number | null,
  endedAt: number | null,
): string {
  if (startedAt == null || endedAt == null) return "—";
  const secs = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const ITEM_GLYPH: Record<CallItemType, string> = {
  action: "↴",
  decision: "◈",
  context: "◷",
};

const ITEM_LABEL: Record<CallItemType, string> = {
  action: "ACTION",
  decision: "DECISION",
  context: "CONTEXT",
};

function statusTone(status: string | undefined): string {
  switch (status) {
    case "done":
      return C.green;
    case "failed":
    case "cancelled":
      return "var(--mv1-red, #C4443A)";
    case "running":
    case "awaiting_review":
      return C.violet;
    default:
      return C.t3;
  }
}

// ── Presentational panel (fixture-testable, no data fetching) ─────────────

export function CallTranscriptPanel({
  view,
  onCallBack,
  onFileAll,
  callingBack = false,
}: {
  view: CallView;
  onCallBack?: () => void;
  onFileAll?: () => void;
  callingBack?: boolean;
}) {
  const directionLabel =
    view.direction === "inbound" ? "Inbound call" : "Outbound call";
  const dateLabel =
    view.startedAt != null
      ? new Date(view.startedAt).toLocaleString(undefined, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        })
      : null;

  const actionCount = view.items.filter((i) => i.type === "action").length;

  return (
    <div
      data-testid="call-transcript"
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        maxWidth: 720,
        margin: "0 auto",
        padding: "22px 20px 60px",
      }}
    >
      {/* Header */}
      <div
        data-slot="hq-detail-hero"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: view.direction === "inbound" ? C.blue : C.violet,
            }}
          >
            {directionLabel} · Cue receptionist
          </div>
          <div
            style={{
              fontFamily: serif,
              fontSize: 34,
              lineHeight: 1.05,
              marginTop: 6,
              color: C.ink,
            }}
          >
            {view.counterparty || "Unknown number"}
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: C.t3,
              marginTop: 8,
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <span>{formatDuration(view.startedAt, view.endedAt)}</span>
            <span style={{ color: statusTone(view.status) }}>
              {view.status}
            </span>
            {dateLabel ? <span>{dateLabel}</span> : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            onClick={onCallBack}
            disabled={callingBack || !view.counterparty}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
              color: "#fff",
              background: C.blue,
              border: "none",
              borderRadius: 9,
              padding: "9px 15px",
              cursor: callingBack || !view.counterparty ? "default" : "pointer",
              opacity: callingBack || !view.counterparty ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {callingBack ? "Dialing…" : "Call back"}
          </button>
          <button
            type="button"
            onClick={onFileAll}
            disabled={actionCount === 0}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
              color: C.t1,
              background: C.surface,
              border: `1px solid ${C.line}`,
              borderRadius: 9,
              padding: "9px 15px",
              cursor: actionCount === 0 ? "default" : "pointer",
              opacity: actionCount === 0 ? 0.5 : 1,
              whiteSpace: "nowrap",
            }}
          >
            File all{actionCount > 0 ? ` (${actionCount})` : ""}
          </button>
        </div>
      </div>

      {/* Extracted items */}
      <section style={{ marginTop: 26 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.t3,
            marginBottom: 10,
          }}
        >
          What Cue took from the call
        </div>
        {view.items.length === 0 ? (
          <div
            style={{
              fontFamily: serif,
              fontSize: 17,
              color: C.t2,
              padding: "14px 0",
            }}
          >
            Nothing to act on — the call left no follow-ups.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {view.items.map((item) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  background: C.surface,
                  border: `1px solid ${C.line}`,
                  borderRadius: 12,
                  padding: "12px 14px",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    fontSize: 16,
                    lineHeight: "22px",
                    color:
                      item.type === "action"
                        ? C.blue
                        : item.type === "decision"
                          ? C.violet
                          : C.t3,
                    width: 18,
                    textAlign: "center",
                    flexShrink: 0,
                  }}
                >
                  {ITEM_GLYPH[item.type]}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, lineHeight: 1.35 }}>
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: C.t3,
                      marginTop: 4,
                      display: "flex",
                      gap: 10,
                    }}
                  >
                    <span>{ITEM_LABEL[item.type]}</span>
                    {item.type === "action" && item.status ? (
                      <span style={{ color: statusTone(item.status) }}>
                        {item.status}
                        {item.assignee ? ` · ${item.assignee}` : ""}
                      </span>
                    ) : item.type !== "action" ? (
                      <span title="Not persisted yet">NEEDS BACKEND</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Transcript */}
      <section style={{ marginTop: 30 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.t3,
            marginBottom: 12,
          }}
        >
          Transcript
        </div>
        {view.transcript.length === 0 ? (
          <div style={{ fontFamily: serif, fontSize: 17, color: C.t2 }}>
            No transcript was captured for this call.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {view.transcript.map((turn, i) => {
              const isCue = turn.speaker === "cue";
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isCue ? "flex-start" : "flex-end",
                  }}
                >
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: 9.5,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: isCue ? C.blue : C.t3,
                      marginBottom: 4,
                    }}
                  >
                    {isCue ? "Cue" : "Caller"}
                  </div>
                  <div
                    style={{
                      maxWidth: "78%",
                      fontSize: 14.5,
                      lineHeight: 1.5,
                      color: C.t1,
                      background: isCue ? C.surface : C.blue,
                      ...(isCue
                        ? { border: `1px solid ${C.line}` }
                        : { color: "#fff" }),
                      borderRadius: 14,
                      padding: "10px 14px",
                    }}
                  >
                    {turn.text}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Container (real data) ─────────────────────────────────────────────────

export function CallTranscriptView({
  callSessionId,
}: {
  callSessionId: string;
}) {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const callQuery = useQuery({
    ...callsByCallSessionIdGetOptions({
      path: { assistant_id: assistantId, callSessionId },
    }),
    staleTime: 15_000,
  });

  const conversationId = callQuery.data?.conversationId;

  const messagesQuery = useQuery({
    ...messagesGetOptions({
      path: { assistant_id: assistantId },
      query: { conversationId: conversationId ?? "", limit: 200 },
    }),
    enabled: !!conversationId,
    staleTime: 15_000,
  });

  const itemsQuery = useQuery({
    ...workitemsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 15_000,
  });

  const callBack = useMutation({ ...callsStartPostMutation() });

  const view = useMemo<CallView | null>(() => {
    const call = callQuery.data;
    if (!call || !conversationId) return null;

    const direction: "inbound" | "outbound" = call.task
      ? "outbound"
      : "inbound";
    const counterparty =
      direction === "inbound" ? call.fromNumber : call.toNumber;

    const transcript: CallTranscriptTurn[] = (
      messagesQuery.data?.messages ?? []
    )
      .map((m): CallTranscriptTurn | null => {
        const text = cleanSpokenLine(m.content ?? "");
        if (!text) return null;
        if (
          text.startsWith("(call connected") ||
          text.startsWith("(verification")
        )
          return null;
        return { speaker: m.role === "assistant" ? "cue" : "caller", text };
      })
      .filter((t): t is CallTranscriptTurn => t !== null);

    // Work items this call filed — matched on the extractor's sourceContext.
    const items: CallExtractedItem[] = (itemsQuery.data?.items ?? [])
      .filter((wi) => {
        if (!wi.sourceContext) return false;
        try {
          const ctx = JSON.parse(wi.sourceContext) as {
            callSessionId?: string;
            sourceId?: string;
            origin?: string;
          };
          return (
            ctx.callSessionId === callSessionId ||
            (ctx.origin === "phone" && ctx.sourceId === conversationId)
          );
        } catch {
          return false;
        }
      })
      .map((wi) => ({
        id: wi.id,
        type: "action" as const,
        title: wi.title,
        status: wi.status,
        assignee: wi.assignee,
      }));

    return {
      callSessionId,
      conversationId,
      direction,
      counterparty,
      status: call.status,
      startedAt: call.startedAt ? Date.parse(call.startedAt) : null,
      endedAt: call.endedAt ? Date.parse(call.endedAt) : null,
      transcript,
      items,
    };
  }, [
    callQuery.data,
    conversationId,
    messagesQuery.data,
    itemsQuery.data,
    callSessionId,
  ]);

  if (callQuery.isLoading) {
    return (
      <div style={{ padding: 40, fontFamily: mono, fontSize: 12, color: C.t3 }}>
        Loading call…
      </div>
    );
  }
  if (!view) {
    return (
      <div
        style={{ padding: 40, fontFamily: serif, fontSize: 18, color: C.t2 }}
      >
        That call couldn't be found.
      </div>
    );
  }

  return (
    <CallTranscriptPanel
      view={view}
      callingBack={callBack.isPending}
      onCallBack={() => {
        if (!view.counterparty) return;
        callBack.mutate({
          path: { assistant_id: assistantId },
          body: {
            phoneNumber: view.counterparty,
            conversationId: view.conversationId,
            context: `Returning a ${view.direction} call with ${view.counterparty}.`,
          },
        });
      }}
      onFileAll={() => {
        // Actions are auto-filed on hang-up; "File all" jumps to the work
        // queue where they're already waiting.
        navigate(routes.home ?? "/");
      }}
    />
  );
}
