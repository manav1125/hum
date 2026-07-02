/**
 * "Your next move" — the AI chief-of-staff HERO.
 *
 * The headline surface of the Command Center: a single, prominent focus card
 * that names the ONE thing most worth the user's attention right now, why it
 * matters, and the buttons to act on it without leaving the page. It sits above
 * the calm editorial stream and is the first thing the eye lands on.
 *
 * Data comes from {@link ./use-next-move} (the daemon's `next-move` endpoint),
 * which derives the move from the same approval / work-item / feed stores the
 * stream below reads — so the hero and the stream never disagree. Actions carry
 * their own `endpoint` + `method` from the daemon and are dispatched through the
 * authed daemon `client`; `open_thread` is handled here as a navigation to the
 * source conversation. On success every command-center cache is invalidated so
 * the move recomputes and the card re-reveals.
 *
 * When there's no move, the card is a warm, calm "You're all caught up" — never
 * a big empty void.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, ExternalLink, Play, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { client } from "@/generated/daemon/client.gen";

import { C, mono, serif } from "@/domains/activity/theme";
import {
  nextMoveQueryKey,
  useNextMove,
  type NextMoveAction,
} from "./use-next-move";

/** Icon per action kind — keeps the buttons legible at a glance. */
function actionIcon(kind: NextMoveAction["kind"]): ReactNode {
  const size = 14;
  switch (kind) {
    case "approve":
      return <Check size={size} />;
    case "decline":
      return <X size={size} />;
    case "run":
      return <Play size={size} />;
    case "open_thread":
      return <ExternalLink size={size} />;
    case "snooze":
      return <Clock size={size} />;
  }
}

/** Approve / Run are the loud primary; everything else is a quiet secondary. */
function isPrimary(kind: NextMoveAction["kind"]): boolean {
  return kind === "approve" || kind === "run";
}

function HeroButton({
  action,
  busy,
  onClick,
}: {
  action: NextMoveAction;
  busy: boolean;
  onClick: () => void;
}) {
  const primary = isPrimary(action.kind);
  const danger = action.kind === "decline";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 38,
        padding: "0 16px",
        borderRadius: 10,
        fontSize: 13.5,
        fontWeight: 600,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        whiteSpace: "nowrap",
        transition: "transform .12s ease, box-shadow .12s ease, background .12s ease",
        border: primary
          ? "none"
          : `1px solid ${
              danger
                ? `color-mix(in srgb, ${C.danger} 30%, transparent)`
                : C.line2
            }`,
        background: primary
          ? C.blue
          : danger
            ? `color-mix(in srgb, ${C.danger} 12%, transparent)`
            : C.surface,
        color: primary ? "#FFFFFF" : danger ? C.danger : C.t1,
        boxShadow: primary ? "0 1px 2px rgba(61,110,232,.28)" : "none",
      }}
      onMouseEnter={(e) => {
        if (busy) return;
        e.currentTarget.style.transform = "translateY(-1px)";
        if (primary)
          e.currentTarget.style.boxShadow = "0 4px 12px rgba(61,110,232,.32)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        if (primary)
          e.currentTarget.style.boxShadow = "0 1px 2px rgba(61,110,232,.28)";
      }}
    >
      {actionIcon(action.kind)}
      {action.label}
    </button>
  );
}

/** Calm, warm caught-up state — a card, not a void. */
function CaughtUpCard() {
  return (
    <div
      data-slot="next-move-caughtup"
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 16,
        background: `linear-gradient(180deg, ${C.surface} 0%, ${C.sunken} 140%)`,
        padding: "20px 22px",
        marginBottom: 30,
        display: "flex",
        alignItems: "center",
        gap: 14,
        animation: "cueHeroReveal .5s cubic-bezier(.22,.61,.36,1) both",
      }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 11,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `color-mix(in srgb, ${C.green} 14%, transparent)`,
          border: `1px solid color-mix(in srgb, ${C.green} 32%, transparent)`,
          flexShrink: 0,
        }}
      >
        <Check size={18} color={C.green} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: serif,
            fontSize: 19,
            lineHeight: 1.15,
            letterSpacing: "-0.3px",
            color: C.ink,
          }}
        >
          You&rsquo;re all caught up.
        </div>
        <div style={{ fontSize: 13, color: C.t2, marginTop: 3, lineHeight: 1.5 }}>
          Nothing needs a decision right now. Cue is watching your inbox and
          standing by — the moment something matters, it&rsquo;ll surface here.
        </div>
      </div>
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 16,
        background: C.surface,
        padding: "20px 22px",
        marginBottom: 30,
        opacity: 0.7,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: C.t3,
        }}
      >
        ✦ Your next move
      </div>
      <div style={{ fontSize: 14, color: C.t3, marginTop: 8 }}>
        Reading the room…
      </div>
    </div>
  );
}

export function NextMoveHero({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { move, isLoading } = useNextMove(assistantId);

  const recompute = (): void =>
    void queryClient.invalidateQueries({
      queryKey: nextMoveQueryKey(assistantId),
    });

  // Dispatch an action through the authed daemon client using the endpoint +
  // method the move attached. Any command-center cache may shift as a result,
  // so we broadly recompute the move + let `useActivitySync` (mounted on the
  // page) catch the SSE that the daemon emits for the lanes below.
  const act = useMutation({
    mutationFn: async (action: NextMoveAction) => {
      if (action.kind === "open_thread") return;
      if (!action.endpoint) return;
      const method = action.method ?? "POST";
      const opts = { url: action.endpoint, throwOnError: true } as const;
      if (method === "GET") {
        await client.get(opts);
      } else if (method === "PATCH") {
        await client.patch(opts);
      } else if (method === "DELETE") {
        await client.delete(opts);
      } else {
        await client.post(opts);
      }
    },
    onSuccess: () => recompute(),
  });

  const onAction = (action: NextMoveAction): void => {
    if (action.kind === "open_thread") {
      const cid = move.sourceConversationId;
      if (cid) navigate(`/assistant/conversations/${cid}`);
      return;
    }
    act.mutate(action);
  };

  if (isLoading) return <HeroSkeleton />;
  if (!move.hasMove) return <CaughtUpCard />;

  return (
    <div
      data-slot="next-move-hero"
      style={{
        position: "relative",
        border: `2px solid ${C.blue}`,
        borderRadius: 16,
        background: `linear-gradient(180deg, color-mix(in srgb, ${C.blue} 4%, ${C.surface}) 0%, ${C.surface} 60%)`,
        padding: "20px 22px 22px",
        marginBottom: 30,
        boxShadow: "0 6px 24px rgba(61,110,232,.10)",
        animation: "cueHeroReveal .5s cubic-bezier(.22,.61,.36,1) both",
        overflow: "hidden",
      }}
    >
      {/* Soft accent glow rail at the top edge. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: `linear-gradient(90deg, ${C.blue}, ${C.violet})`,
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: C.blueS,
        }}
      >
        <Sparkles size={12} color={C.blue} />
        Your next move
      </div>

      <div
        style={{
          fontFamily: serif,
          fontSize: 23,
          lineHeight: 1.18,
          letterSpacing: "-0.4px",
          color: C.ink,
          marginTop: 8,
        }}
      >
        {move.headline}
      </div>

      {move.reasoning ? (
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            color: C.t2,
            marginTop: 8,
            maxWidth: 640,
          }}
        >
          {move.reasoning}
        </div>
      ) : null}

      {move.actions.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            marginTop: 18,
          }}
        >
          {move.actions.map((action) => (
            <HeroButton
              key={action.id}
              action={action}
              busy={act.isPending}
              onClick={() => onAction(action)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
