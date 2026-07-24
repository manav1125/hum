import type { LucideIcon } from "lucide-react";

/**
 * A styled fallback thumbnail for library cards that have no real preview image
 * (documents, audio, and any video/image whose thumbnail wasn't generated).
 * Instead of a blank grey box with a lone icon, it renders a deterministic
 * gradient — derived from the item's seed so each card gets a consistent,
 * distinct look — with the type icon and an optional label. Keeps the grid
 * feeling intentional rather than empty.
 */

/** Curated, theme-neutral gradient pairs (readable with white foreground). */
const GRADIENTS: readonly [string, string][] = [
  ["#6366F1", "#8B5CF6"],
  ["#0EA5E9", "#6366F1"],
  ["#10B981", "#0EA5E9"],
  ["#F59E0B", "#EF4444"],
  ["#EC4899", "#8B5CF6"],
  ["#14B8A6", "#3B82F6"],
  ["#F43F5E", "#F59E0B"],
  ["#8B5CF6", "#EC4899"],
];

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

interface LibraryCardPlaceholderProps {
  seed: string;
  icon: LucideIcon;
  label?: string;
}

export function LibraryCardPlaceholder({
  seed,
  icon: Icon,
  label,
}: LibraryCardPlaceholderProps) {
  const [from, to] = GRADIENTS[hashSeed(seed) % GRADIENTS.length];
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-2"
      style={{
        background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`,
      }}
    >
      <Icon size={30} className="text-white/85" strokeWidth={1.75} />
      {label ? (
        <span className="text-body-small-default font-medium text-white/85">
          {label}
        </span>
      ) : null}
    </div>
  );
}
