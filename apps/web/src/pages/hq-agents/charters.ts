/**
 * Agent charters — the registry behind the Agents · org page, now backed by
 * the daemon's server-side agent registry (GET/POST/PATCH/DELETE
 * /v1/assistants/{id}/agents). Rename / re-charter / change tier / set spend
 * cap / pause / hire / retire all persist server-side and are shared across
 * devices and surfaces.
 *
 * The UI contract is preserved: `useCharters` returns a reactive `AgentCharter[]`
 * and `useCharterActions` returns the same update / hire / retire verbs the ⋯
 * menu and modals have always called — only the storage moved from localStorage
 * to the registry. `tier`/`capCents` translate between the wire shape (tier as
 * a '1'..'4' string, cap in cents) and the UI shape (numeric tier, cap in USD).
 *
 * What stays honest: nothing here fabricates work, spend, or track record —
 * live work comes from real work items by assignee, per-agent spend from the
 * new attribution endpoint, and the track record from the acts ledger (see
 * `use-agent-data.ts`), each with its own "measuring…" fallback.
 */

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  agentsByIdDeleteMutation,
  agentsByIdPatchMutation,
  agentsGetOptions,
  agentsGetQueryKey,
  agentsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AgentsGetResponses } from "@/generated/daemon/types.gen";

export type AgentTier = 1 | 2 | 3 | 4;

/** One registry row, shaped for the org UI (numeric tier, cap in USD). */
export interface AgentCharter {
  id: string;
  /** Display + work-item assignee match key (case-insensitive). */
  name: string;
  /** Single glyph for the role tile (⚙ ▲ ✦ …). */
  emoji: string;
  /** Short domain blurb under the name ("Operations"). */
  domain: string;
  /** The standing mandate shown in the CHARTER box. */
  charter: string;
  tier: AgentTier;
  /** Weekly spend cap in USD; null = no cap. */
  capUsd: number | null;
  paused: boolean;
  /** Epoch ms the role was hired ("since March"). */
  hiredAt: number;
}

type ApiAgent = AgentsGetResponses[200]["agents"][number];

/** Tier chip label + the static may-do / always-asks trust copy. */
export const TIER_META: Record<
  AgentTier,
  {
    chip: string;
    dial: string;
    mayDo: string[];
    alwaysAsks: string;
  }
> = {
  1: {
    chip: "TIER 1",
    dial: "1 · Suggests",
    mayDo: [
      "Research, plan, and propose next moves",
      "Prepare briefs and options for you",
    ],
    alwaysAsks: "Any action that leaves the building",
  },
  2: {
    chip: "TIER 2",
    dial: "2 · Drafts",
    mayDo: [
      "Draft emails, docs, and replies for review",
      "Prepare and stage work inside the workspace",
    ],
    alwaysAsks: "Anything that sends or publishes",
  },
  3: {
    chip: "TIER 3",
    dial: "3 · Acts in budget",
    mayDo: [
      "Send routine email & scheduling",
      "Spend up to its cap per mission on tools",
    ],
    alwaysAsks: "Sign contracts or move money",
  },
  4: {
    chip: "TIER 4",
    dial: "4 · Full",
    mayDo: [
      "Act on its own within your never-lines",
      "Spend within its cap without check-ins",
    ],
    alwaysAsks: "Your never-lines — always",
  },
};

// ---------------------------------------------------------------------------
// Wire ⇄ UI mapping
// ---------------------------------------------------------------------------

function toTier(v: string): AgentTier {
  const n = Number(v);
  return n === 2 || n === 3 || n === 4 ? (n as AgentTier) : 1;
}

/** Map a registry row to the org-UI charter shape (cents → USD, tier string). */
function fromApi(a: ApiAgent): AgentCharter {
  return {
    id: a.id,
    name: a.name,
    emoji: a.emoji && a.emoji.length > 0 ? a.emoji : "◆",
    domain: a.domain ?? "",
    charter: a.charter ?? "",
    tier: toTier(a.tier),
    capUsd:
      a.capCents != null && a.capCents > 0
        ? Math.round(a.capCents / 100)
        : null,
    paused: a.paused === 1,
    hiredAt: a.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SAFETY_NET_MS = 60_000;

/** Reactive charter list for one assistant, from the server registry. */
export function useCharters(assistantId: string): AgentCharter[] {
  const query = useQuery({
    ...agentsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });
  return useMemo(
    () => (query.data?.agents ?? []).map(fromApi),
    [query.data],
  );
}

// ---------------------------------------------------------------------------
// Writes — the ⋯-menu / modal verbs, now persisted server-side.
// ---------------------------------------------------------------------------

/** Patch fields the editor can change (UI shape). */
export type CharterPatch = Partial<
  Pick<AgentCharter, "name" | "emoji" | "domain" | "charter" | "tier" | "capUsd" | "paused">
>;

/** New-role draft for the Hire modal (UI shape). */
export type CharterDraft = Pick<
  AgentCharter,
  "name" | "emoji" | "domain" | "charter" | "tier"
>;

/**
 * The charter action verbs, bound to one assistant. Each mutation invalidates
 * the roster query so the UI reflects the persisted state. The imperative
 * signatures (`update(id, patch)`, `hire(draft)`, `retire(id)`) mirror the
 * former localStorage store so call sites barely change.
 */
export function useCharterActions(assistantId: string): {
  update: (id: string, patch: CharterPatch) => void;
  hire: (draft: CharterDraft) => void;
  retire: (id: string) => void;
} {
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: agentsGetQueryKey({ path: { assistant_id: assistantId } }),
    });

  const patch = useMutation({
    ...agentsByIdPatchMutation(),
    onSettled: invalidate,
  });
  const post = useMutation({
    ...agentsPostMutation(),
    onSettled: invalidate,
  });
  const del = useMutation({
    ...agentsByIdDeleteMutation(),
    onSettled: invalidate,
  });

  return {
    update: (id, p) => {
      const body: Record<string, unknown> = {};
      if (p.name !== undefined) body.name = p.name;
      if (p.emoji !== undefined) body.emoji = p.emoji;
      if (p.domain !== undefined) body.domain = p.domain;
      if (p.charter !== undefined) body.charter = p.charter;
      if (p.tier !== undefined) body.tier = String(p.tier);
      if (p.capUsd !== undefined) {
        body.capCents = p.capUsd != null ? Math.round(p.capUsd * 100) : null;
      }
      if (p.paused !== undefined) body.paused = p.paused;
      patch.mutate({
        path: { assistant_id: assistantId, id },
        body: body as never,
      });
    },
    hire: (draft) => {
      post.mutate({
        path: { assistant_id: assistantId },
        body: {
          name: draft.name,
          emoji: draft.emoji,
          domain: draft.domain,
          charter: draft.charter,
          tier: String(draft.tier),
        } as never,
      });
    },
    retire: (id) => {
      del.mutate({ path: { assistant_id: assistantId, id } });
    },
  };
}

/** "since March" / "since Mar 2025" label from the hire stamp. */
export function sinceLabel(hiredAt: number, now: number): string | null {
  if (!Number.isFinite(hiredAt) || hiredAt <= 0) return null;
  const d = new Date(hiredAt);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `since ${d.toLocaleDateString(undefined, {
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  })}`;
}
