/**
 * Agent charters — the client-side registry behind the Agents · org page.
 *
 * Phase 1 has NO server-side agent registry yet: charters (name, emoji,
 * domain, mandate, autonomy tier, spend cap, paused) are a local, per-assistant
 * config persisted in localStorage. The full ⋯-menu contract from the design
 * doc (rename / re-charter / change tier / set spend cap / pause / hire) edits
 * this config, so the UI contract is fixed NOW and the storage swaps to the
 * daemon's agent registry later without call-site churn.
 *
 * What stays honest: nothing here fabricates work, spend, or track record —
 * those come from real stores (work items by assignee, the usage API, the
 * acts-summary probe) in `use-agent-data.ts`, or render the "measuring"
 * treatment when unattributed.
 */

import { useSyncExternalStore } from "react";

export type AgentTier = 1 | 2 | 3 | 4;

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
  /** Weekly spend cap in USD the user intends for this role; null = no cap. */
  capUsd: number | null;
  paused: boolean;
  /** Epoch ms when this charter was added locally ("since March"). */
  hiredAt: number;
}

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

/** The three default charters every org starts with (design doc). */
function defaultCharters(now: number): AgentCharter[] {
  return [
    {
      id: "ops",
      name: "Ops",
      emoji: "⚙",
      domain: "Operations",
      charter: "Keep the raise & ops moving — never let a thread go cold.",
      tier: 3,
      capUsd: null,
      paused: false,
      hiredAt: now,
    },
    {
      id: "builder",
      name: "Builder",
      emoji: "▲",
      domain: "Product",
      charter: "Ship product on cadence — quality over speed.",
      tier: 2,
      capUsd: null,
      paused: false,
      hiredAt: now,
    },
    {
      id: "growth",
      name: "Growth",
      emoji: "✦",
      domain: "Marketing",
      charter: "Grow pipeline & MRR — protect the brand voice.",
      tier: 2,
      capUsd: null,
      paused: false,
      hiredAt: now,
    },
  ];
}

const VERSION = 1;

function storageKey(assistantId: string): string {
  return `cue.hqAgents.charters.v${VERSION}:${assistantId}`;
}

function isTier(v: unknown): v is AgentTier {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

function narrowCharter(raw: unknown): AgentCharter | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  return {
    id: r.id,
    name: r.name,
    emoji: typeof r.emoji === "string" && r.emoji.length > 0 ? r.emoji : "◆",
    domain: typeof r.domain === "string" ? r.domain : "",
    charter: typeof r.charter === "string" ? r.charter : "",
    tier: isTier(r.tier) ? r.tier : 1,
    capUsd:
      typeof r.capUsd === "number" && Number.isFinite(r.capUsd) && r.capUsd > 0
        ? r.capUsd
        : null,
    paused: r.paused === true,
    hiredAt:
      typeof r.hiredAt === "number" && Number.isFinite(r.hiredAt)
        ? r.hiredAt
        : 0,
  };
}

// ---------------------------------------------------------------------------
// Store — one cached snapshot per assistant, useSyncExternalStore-compatible.
// ---------------------------------------------------------------------------

const cache = new Map<string, AgentCharter[]>();
const listeners = new Set<() => void>();

function load(assistantId: string): AgentCharter[] {
  const cached = cache.get(assistantId);
  if (cached) return cached;
  let charters: AgentCharter[] | null = null;
  try {
    const raw = localStorage.getItem(storageKey(assistantId));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const narrowed = parsed
          .map(narrowCharter)
          .filter((c): c is AgentCharter => c !== null);
        if (narrowed.length > 0) charters = narrowed;
      }
    }
  } catch {
    // Corrupt/blocked storage — fall through to defaults.
  }
  if (!charters) {
    charters = defaultCharters(Date.now());
    persist(assistantId, charters);
  }
  cache.set(assistantId, charters);
  return charters;
}

function persist(assistantId: string, charters: AgentCharter[]): void {
  try {
    localStorage.setItem(storageKey(assistantId), JSON.stringify(charters));
  } catch {
    // Storage full/blocked — the in-memory copy still drives the session.
  }
}

function write(assistantId: string, next: AgentCharter[]): void {
  cache.set(assistantId, next);
  persist(assistantId, next);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive charter list for one assistant. */
export function useCharters(assistantId: string): AgentCharter[] {
  return useSyncExternalStore(
    subscribe,
    () => load(assistantId),
    () => load(assistantId),
  );
}

/** Patch one charter by id (rename / re-charter / tier / cap / pause). */
export function updateCharter(
  assistantId: string,
  id: string,
  patch: Partial<Omit<AgentCharter, "id">>,
): void {
  const next = load(assistantId).map((c) =>
    c.id === id ? { ...c, ...patch } : c,
  );
  write(assistantId, next);
}

/** "Hire an agent" — add a new role to the org. */
export function hireCharter(
  assistantId: string,
  draft: Pick<AgentCharter, "name" | "emoji" | "domain" | "charter" | "tier">,
): AgentCharter {
  const charter: AgentCharter = {
    ...draft,
    id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    capUsd: null,
    paused: false,
    hiredAt: Date.now(),
  };
  write(assistantId, [...load(assistantId), charter]);
  return charter;
}

/** Retire a role (kept for the future menu; not surfaced in phase 1). */
export function retireCharter(assistantId: string, id: string): void {
  write(
    assistantId,
    load(assistantId).filter((c) => c.id !== id),
  );
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
