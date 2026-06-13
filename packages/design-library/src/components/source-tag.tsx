import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";

/**
 * SourceTag — a DM Mono provenance chip that colors a memory by its type.
 * Cue's 8-type memory shows up everywhere (Memory page, Intelligence hub,
 * meeting recaps) tagged with where it came from; the mono face + colored dot
 * make the type scannable (design-book: "semantic · concise", "prospective ·
 * Acme Q3"). Each type maps to a `--memory-*` token — no hard-coded color.
 *
 * Use `memoryType` for a typed memory, or omit it for a neutral source label
 * (e.g. "source: gmail").
 */
export type MemoryType =
  | "episodic"
  | "semantic"
  | "procedural"
  | "prospective"
  | "emotional"
  | "behavioral"
  | "narrative"
  | "shared";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "episodic",
  "semantic",
  "procedural",
  "prospective",
  "emotional",
  "behavioral",
  "narrative",
  "shared",
];

const memoryColorVar = (type: MemoryType): string => `var(--memory-${type})`;

export interface SourceTagProps
  extends Omit<ComponentProps<"span">, "children"> {
  /** Memory type — drives the dot + text color. Omit for a neutral source. */
  memoryType?: MemoryType;
  /** Show the leading color dot. Defaults to true. */
  showDot?: boolean;
  /** Label. Defaults to the memory type name when `memoryType` is set. */
  children?: ReactNode;
}

export function SourceTag({
  memoryType,
  showDot = true,
  children,
  className,
  ref,
  ...rest
}: SourceTagProps) {
  const color = memoryType ? memoryColorVar(memoryType) : undefined;
  const label = children ?? memoryType;

  return (
    <span
      {...rest}
      ref={ref}
      data-slot="source-tag"
      data-memory-type={memoryType}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[6px] px-1.5 py-0.5",
        "font-mono text-body-small-default leading-none whitespace-nowrap select-none",
        className,
      )}
      style={
        color
          ? {
              backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
              color,
            }
          : {
              backgroundColor: "var(--tag-bg-neutral)",
              color: "var(--content-secondary)",
            }
      }
    >
      {showDot ? (
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color ?? "var(--content-tertiary)" }}
        />
      ) : null}
      {label}
    </span>
  );
}
