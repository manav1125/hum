import type { SkillOrigin } from "@/domains/intelligence/skills/types";

const C = {
  line: "#E5E9F0",
  t2: "#5A6672",
} as const;

const ORIGIN_META: Record<SkillOrigin, { label: string; glyph: string }> = {
  vellum: { label: "Cue", glyph: "◧" },
  clawhub: { label: "Clawhub", glyph: "🌐" },
  skillssh: { label: "skills.sh", glyph: "⌘" },
  custom: { label: "Custom", glyph: "✦" },
  design: { label: "Design", glyph: "🎨" },
};

/**
 * Bordered origin pill matching the `◧ Cue` tag in surfaces/Skills.dc.html.
 * Falls back to a humanized label for any unknown origin string.
 */
export function SkillOriginTag({ origin }: { origin: SkillOrigin | string }) {
  const meta =
    origin in ORIGIN_META
      ? ORIGIN_META[origin as SkillOrigin]
      : { label: origin.replace(/-/g, " "), glyph: "✦" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: `1px solid ${C.line}`,
        borderRadius: 7,
        padding: "2px 8px",
        fontSize: 11,
        color: C.t2,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{meta.glyph}</span> {meta.label}
    </span>
  );
}
