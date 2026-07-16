/**
 * Resolve a work item's `assignee` to a named roster agent for display.
 *
 * Attribution rides on the free-text `assignee` string — the only agent link
 * on the work-item route. Mission-planned items carry a roster name; captured
 * channel commitments are stamped "Inbox"; other triage defaults to "cue".
 * Returns null for items owned by the user or an outside contact — we never
 * fake an agent identity we don't have. `emoji` is the roster's self-chosen
 * glyph; AgentChip colors the known roles (Ops/Growth/Inbox) and falls back to
 * neutral for anything else.
 */
import { useMemo } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useCharters } from "@/pages/hq-agents/charters";

export interface ResolvedAgent {
  name: string;
  emoji?: string;
}

export function useAgentFor(
  assignee: string | null | undefined,
): ResolvedAgent | null {
  const assistantId = useActiveAssistantId();
  const charters = useCharters(assistantId);
  return useMemo(() => {
    const key = (assignee ?? "").trim().toLowerCase();
    if (!key || key === "you") return null;
    const match = charters.find(
      (c) => c.name.trim().toLowerCase() === key || c.id.toLowerCase() === key,
    );
    if (match) return { name: match.name, emoji: match.emoji };
    if (key === "cue") return { name: "Cue" };
    return null;
  }, [assignee, charters]);
}
