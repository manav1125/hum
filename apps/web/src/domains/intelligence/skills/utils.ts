import { type SkillFilter, type SkillInfo, isInstalledSkill } from "./types";

/**
 * Display-side Vellum→Cue rebrand for skill prose (names/descriptions that
 * arrive from skill data — seeded SKILL.md frontmatter, marketplace catalog
 * entries — still say "…into Vellum…", mobile UAT P1-15).
 *
 * Rebrand boundary: ONLY the standalone capitalized product name is display
 * text. Lowercase `vellum` is a protocol/infra id (skill origin "vellum",
 * `vellum://` deep links, `@vellumai/*` packages, `vellum-*` slugs) and must
 * pass through untouched — the word-boundary + capital-V match guarantees
 * ids, URLs and package names are never rewritten.
 */
export function rebrandSkillProse(text: string): string;
export function rebrandSkillProse(
  text: string | null | undefined,
): string | null | undefined;
export function rebrandSkillProse(
  text: string | null | undefined,
): string | null | undefined {
  if (!text) return text;
  return text.replace(/\bVellum\b/g, "Cue");
}

/**
 * Display label for a skill's source/origin id (mobile UAT: raw "vellum"
 * leaked as the visible source). Display-only — the protocol id itself is
 * never renamed.
 */
export function skillOriginLabel(
  origin: string | null | undefined,
): string | null {
  switch (origin) {
    case "vellum":
      return "Cue official";
    case "custom":
      return "Custom";
    case "clawhub":
      return "Clawhub";
    case "skillssh":
      return "skills.sh";
    default:
      return origin ?? null;
  }
}

export function resolveFilterParams(filter: SkillFilter): {
  origin?: string;
  kind?: "installed" | "available";
} {
  switch (filter) {
    case "installed":
      return { kind: "installed" };
    case "available":
      return { kind: "available" };
    case "vellum":
    case "clawhub":
    case "skillssh":
    case "custom":
      return { origin: filter };
    default:
      return {};
  }
}

export function sortSkills(skills: SkillInfo[]): SkillInfo[] {
  return [...skills].sort((a, b) => {
    const aInstalled = isInstalledSkill(a);
    const bInstalled = isInstalledSkill(b);
    if (aInstalled !== bInstalled) return aInstalled ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
