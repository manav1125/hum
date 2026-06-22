import { LayoutGrid } from "lucide-react";
import { createElement } from "react";

import { resolveCategoryIcon } from "@/domains/intelligence/skills/category-icon-map";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories";

const C = {
  active: "#F0F2F6",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#9AA6B2",
} as const;
const MONO = "'DM Mono', ui-monospace, monospace";

interface SkillCategoryIndexProps {
  categories: CategoryInfo[];
  selected: string | null;
  onSelect: (category: string | null) => void;
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
}

/**
 * The left category rail from surfaces/Skills.dc.html — an "All" row plus one
 * row per category, each with an icon, label, and a DM Mono count. The active
 * row gets the light `#F0F2F6` fill and a heavier weight; others are muted.
 */
export function SkillCategoryIndex({
  categories,
  selected,
  onSelect,
  counts,
  totalCount,
  showCounts,
}: SkillCategoryIndexProps) {
  const sorted = [...categories].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <nav
      aria-label="Skill categories"
      style={{ display: "flex", flexDirection: "column", gap: 1 }}
    >
      <CategoryRow
        icon={LayoutGrid}
        label="All"
        count={totalCount}
        active={selected === null}
        showCount={showCounts}
        onClick={() => onSelect(null)}
      />
      {sorted.map((cat) => (
        <CategoryRow
          key={cat.slug}
          icon={resolveCategoryIcon(cat.icon) ?? LayoutGrid}
          label={cat.label}
          count={counts[cat.slug] ?? 0}
          active={selected === cat.slug}
          showCount={showCounts}
          onClick={() => onSelect(cat.slug)}
        />
      ))}
    </nav>
  );
}

function CategoryRow({
  icon,
  label,
  count,
  active,
  showCount,
  onClick,
}: {
  icon: typeof LayoutGrid;
  label: string;
  count: number;
  active: boolean;
  showCount: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "10px 12px",
        borderRadius: 10,
        border: "none",
        background: active ? C.active : "transparent",
        color: active ? C.t1 : C.t2,
        fontWeight: active ? 500 : 400,
        fontSize: 13.5,
        fontFamily: "inherit",
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
      }}
    >
      <span
        style={{
          width: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
        aria-hidden
      >
        {createElement(icon, { className: "h-4 w-4" })}
      </span>
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {showCount && (
        <span style={{ color: C.t3, fontFamily: MONO, fontSize: 12 }}>
          {count}
        </span>
      )}
    </button>
  );
}
