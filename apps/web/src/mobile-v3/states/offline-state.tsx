/**
 * K1 · Offline — three honest blocks.
 *
 * Design's note, which is also the acceptance criteria:
 *
 *   "Three honest blocks: what's queued (each undoable), what still works, and
 *    what doesn't. Composer recedes with a plain reason rather than failing on
 *    send — RECESSED BACKGROUND, NOT DIMMED TEXT, since that sentence is the
 *    only thing explaining why it's dead. NO SPINNER EVER APPEARS OFFLINE."
 *
 * The spinner rule is the one worth restating in code, because it is not a
 * style preference. A spinner is a promise that something is in flight and will
 * resolve. Offline, nothing is in flight and nothing will resolve until the
 * radio comes back, so a spinner is a lie with a smooth animation on it. Every
 * pending thing here is drawn as a QUEUED ROW with a timestamp and an Undo —
 * static, countable, reversible.
 *
 * `offline-state.test.tsx` asserts the absence directly against the rendered
 * tree rather than trusting this comment.
 */
import { useSyncExternalStore } from "react";

import { haptic } from "@/utils/haptics";

import {
  hasOfflineReplay,
  offlineQueueSnapshot,
  queuedAgo,
  subscribeOfflineQueue,
  undoOfflineAction,
  type QueuedAction,
} from "./offline-queue";

const VERB_GLYPH: Record<QueuedAction["verb"], string> = {
  approve: "↑",
  capture: "↑",
  archive: "◼",
  file: "↴",
  handoff: "⇥",
  later: "◷",
};

export function useOfflineQueue(): QueuedAction[] {
  return useSyncExternalStore(
    subscribeOfflineQueue,
    offlineQueueSnapshot,
    offlineQueueSnapshot,
  );
}

export function OfflineState({
  /** When the local cache was last known-good. `null` when we have never synced. */
  lastSyncedAt,
  onUndone,
}: {
  lastSyncedAt?: number | null;
  onUndone?: (action: QueuedAction) => void;
}) {
  const queue = useOfflineQueue();

  return (
    <div
      data-mv3
      data-mv3-state="offline"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      {/* The bar. A dot AND a sentence — colour is never the carrier. */}
      <div
        role="status"
        style={{
          flexShrink: 0,
          background: "var(--mv3-amber-card-bg)",
          borderBottom: "1px solid var(--mv3-amber-card-border)",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--mv3-amber)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 11, color: "var(--mv3-amber-text)", flex: 1 }}>
          No connection —{" "}
          <b>
            {queue.length === 0
              ? "nothing waiting to send"
              : `${queue.length} ${queue.length === 1 ? "thing" : "things"} waiting to send`}
          </b>
        </span>
      </div>

      <div style={{ padding: "12px 18px 0", flexShrink: 0 }}>
        <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: "-.6px" }}>
          Today
        </div>
        <div
          style={{ fontSize: 11, color: "var(--mv3-muted)", marginTop: 3 }}
        >
          {lastSyncedAt
            ? `Last synced ${queuedAgo(lastSyncedAt)}`
            : "Not synced on this device yet"}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 0" }}>
        {/* Block 1 — what's queued. */}
        <BlockLabel tone="amber">QUEUED · SENDS WHEN YOU&apos;RE BACK</BlockLabel>
        {queue.length === 0 ? (
          <Block>
            <p style={bodyStyle}>
              Nothing is waiting. Anything you approve, capture or archive from
              here queues up and goes out the moment you&apos;re back.
            </p>
          </Block>
        ) : (
          <div
            style={{
              background: "var(--mv3-amber-card-bg)",
              border: "1px solid var(--mv3-amber-card-border)",
              borderRadius: 15,
              marginTop: 8,
              overflow: "hidden",
            }}
          >
            {queue.map((action, i) => (
              <QueuedRow
                key={action.id}
                action={action}
                last={i === queue.length - 1}
                onUndo={() => {
                  const removed = undoOfflineAction(action.id);
                  // Only claim an undo that actually happened.
                  if (!removed) return;
                  void haptic.light();
                  onUndone?.(removed);
                }}
              />
            ))}
          </div>
        )}

        {/* Block 2 — what still works. */}
        <BlockLabel>STILL USABLE</BlockLabel>
        <Block>
          <p style={bodyStyle}>
            Everything you&apos;ve already loaded — today&apos;s deck, your
            things, recent conversations, Library files you&apos;ve opened.{" "}
            <b style={{ color: "var(--mv3-text)" }}>
              Reading works. Approving queues.
            </b>
          </p>
        </Block>

        {/* Block 3 — what doesn't. Said plainly, in the first person, because
            this is Cue reporting its own limits. */}
        <BlockLabel>NOT UNTIL YOU&apos;RE BACK</BlockLabel>
        <Block recessed>
          <p style={{ ...bodyStyle, color: "var(--mv3-muted)" }}>
            New answers from me · Create · voice · anything an agent has to run.{" "}
            <b style={{ color: "var(--mv3-text)" }}>
              I&apos;ll tell you the moment it lands.
            </b>
          </p>
        </Block>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            background: "var(--mv3-card)",
            border: "1px dashed var(--mv3-card-border)",
            borderRadius: 14,
            padding: "11px 13px",
            margin: "12px 0 16px",
          }}
        >
          <span aria-hidden style={{ fontSize: 13, flexShrink: 0 }}>
            ✈
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--mv3-text)",
              flex: 1,
              lineHeight: 1.5,
            }}
          >
            On a plane? Everything you do still queues — nothing is lost.
          </span>
        </div>
      </div>

      {/* The composer, receded. A recessed GROUND plus a full-strength reason —
          never an opacity wrapper, because that sentence is the only thing
          explaining why the field is dead. */}
      <div style={{ flexShrink: 0, padding: "10px 16px 9px" }}>
        <div
          aria-disabled
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            background: "var(--mv3-token-well)",
            border: "1px solid var(--mv3-token-well-border)",
            borderRadius: 19,
            padding: "12px 14px",
          }}
        >
          <span style={{ fontSize: 13.5, color: "var(--mv3-text)", flex: 1 }}>
            I can&apos;t answer offline
          </span>
          <span aria-hidden style={{ fontSize: 12, color: "var(--mv3-muted)" }}>
            ◎
          </span>
        </div>
      </div>
    </div>
  );
}

const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 11.5,
  color: "var(--mv3-text)",
  lineHeight: 1.6,
};

function BlockLabel({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "amber";
}) {
  return (
    <div
      style={{
        fontFamily: "var(--mv3-mono)",
        fontSize: 8.5,
        letterSpacing: ".11em",
        color: tone === "amber" ? "var(--mv3-amber-text)" : "var(--mv3-muted)",
        marginTop: 16,
      }}
    >
      {children}
    </div>
  );
}

function Block({
  children,
  recessed,
}: {
  children: React.ReactNode;
  recessed?: boolean;
}) {
  return (
    <div
      style={{
        background: recessed ? "var(--mv3-token-well)" : "var(--mv3-card)",
        border: `1px solid ${recessed ? "var(--mv3-token-well-border)" : "var(--mv3-card-border)"}`,
        borderRadius: 15,
        padding: "12px 14px",
        marginTop: 8,
      }}
    >
      {children}
    </div>
  );
}

function QueuedRow({
  action,
  last,
  onUndo,
}: {
  action: QueuedAction;
  last: boolean;
  onUndo: () => void;
}) {
  // If nothing knows how to replay this kind, say so here rather than let the
  // row imply a send that will never happen.
  const replayable = hasOfflineReplay(action.replay.kind);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 13px",
        borderBottom: last ? undefined : "1px solid var(--mv3-line)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: 6,
          background: "var(--mv3-amber-card-bg)",
          color: "var(--mv3-amber-text)",
          fontSize: 9,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {VERB_GLYPH[action.verb]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12 }}>{action.label}</div>
        <div
          style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 1 }}
        >
          {queuedAgo(action.queuedAt)}
          {replayable ? null : " · I don't know how to send this one yet"}
        </div>
      </div>
      <button
        type="button"
        onClick={onUndo}
        style={{
          border: "none",
          background: "none",
          padding: "6px 2px",
          minHeight: 32,
          fontSize: 10,
          fontFamily: "inherit",
          color: "var(--mv3-accent-text)",
          cursor: "pointer",
        }}
      >
        Undo
      </button>
    </div>
  );
}
