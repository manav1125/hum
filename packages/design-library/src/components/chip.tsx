import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";

/**
 * Chip — an interactive suggestion pill. The quick-action pills under the Home
 * greeting and the command-palette rows ("Draft follow-up to Dana", "Start
 * meeting capture") are Chips. Pill-shaped, hairline by default; `selected`
 * lights it with the Cue blue accent.
 *
 * Renders a real <button> so it's keyboard-focusable with a token focus ring.
 * Pass `asChild` to render a link or other element instead. For a static,
 * non-interactive label use `Tag`; for memory provenance use `SourceTag`.
 */
const chipVariants = cva(
  [
    "inline-flex items-center gap-1.5 rounded-full border whitespace-nowrap select-none",
    "cursor-pointer transition-colors duration-[var(--anim-snappy)]",
    "keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      size: {
        sm: "h-7 px-2.5 text-body-small-default [&_svg]:size-3.5",
        md: "h-8 px-3 text-body-medium-default [&_svg]:size-4",
      },
      selected: {
        true: [
          "border-[color:color-mix(in_srgb,var(--accent-cue)_45%,transparent)]",
          "bg-[var(--accent-cue-weak)] text-[color:var(--accent-cue-strong)]",
        ].join(" "),
        false: [
          "border-[var(--border-element)] bg-[var(--surface-lift)]",
          "text-[color:var(--content-secondary)]",
          "hover:bg-[var(--surface-active)] hover:text-[color:var(--content-default)]",
        ].join(" "),
      },
    },
    defaultVariants: {
      size: "md",
      selected: false,
    },
  },
);

type ChipVariantProps = VariantProps<typeof chipVariants>;

export type ChipSize = NonNullable<ChipVariantProps["size"]>;

export interface ChipProps
  extends Omit<ComponentProps<"button">, "children">,
    ChipVariantProps {
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  asChild?: boolean;
  children?: ReactNode;
}

export function Chip({
  size = "md",
  selected = false,
  leftIcon,
  rightIcon,
  asChild = false,
  type,
  className,
  children,
  ref,
  ...rest
}: ChipProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      {...rest}
      ref={ref}
      data-slot="chip"
      data-selected={selected || undefined}
      aria-pressed={selected || undefined}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(chipVariants({ size, selected }), className)}
    >
      {leftIcon != null ? (
        <span aria-hidden className="flex shrink-0 items-center justify-center">
          {leftIcon}
        </span>
      ) : null}
      <Slottable>{children}</Slottable>
      {rightIcon != null ? (
        <span aria-hidden className="flex shrink-0 items-center justify-center">
          {rightIcon}
        </span>
      ) : null}
    </Comp>
  );
}

export { chipVariants };
