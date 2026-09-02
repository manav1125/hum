import { useQuery } from "@tanstack/react-query";

import { buildVellumHeaders } from "@/lib/auth/request-headers";
import type { SkillInfo } from "@/domains/intelligence/skills/types";

/**
 * Cue Design skills, surfaced read-only in the unified Skills tab.
 *
 * These live in the Cue Design sidecar (OpenDesign fork) and execute in the
 * design runtime, not Cue's daemon — so they are display cards only, never
 * installed or removed from here. The gateway's `/design/skills` route reads
 * the sidecar server-side and fails open to an empty list, so a design-side
 * outage (or an instance with no design sidecar) simply omits the Design
 * section rather than erroring the tab.
 */

/** The design sidecar's category id, used as a single rail grouping in Cue. */
export const DESIGN_SKILL_CATEGORY = "design";

interface RawDesignSkill {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
}

/** kebab/underscore id → Title Case for display (names arrive as slugs). */
function humanize(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function mapToSkillInfo(raw: RawDesignSkill): SkillInfo {
  return {
    // Namespaced so a design skill can never collide with a Cue daemon skill
    // id in the merged list or the selected-skill lookup.
    id: `design:${raw.id}`,
    name: humanize(raw.name),
    description: (raw.description ?? "").trim(),
    // "bundled" gives the right read-only card behavior for free: no install
    // affordance (isAvailableSkill=false) and a correctly-disabled remove
    // (isRemovableSkill=false) — see skills/types.ts predicates.
    kind: "bundled",
    status: "enabled",
    origin: "design",
    category: DESIGN_SKILL_CATEGORY,
    emoji: "🎨",
  };
}

async function fetchDesignSkills(): Promise<SkillInfo[]> {
  const res = await fetch("/design/skills", {
    headers: buildVellumHeaders(),
    credentials: "include",
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { skills?: RawDesignSkill[] } | RawDesignSkill[];
  const list = Array.isArray(body) ? body : (body.skills ?? []);
  return list
    .filter((s): s is RawDesignSkill => Boolean(s && s.id && s.name))
    .map(mapToSkillInfo);
}

export function useDesignSkills(enabled: boolean) {
  return useQuery({
    queryKey: ["design-skills"],
    queryFn: fetchDesignSkills,
    enabled,
    staleTime: 5 * 60 * 1000,
    // A design-side hiccup must never surface as a Skills-tab error.
    retry: false,
  });
}
