import { forwardRef } from "react";

import { cn } from "@/utils/misc";

import { Button } from "@vellumai/design-library";

/**
 * Suggestion-pill primitive used in the chat empty state. Wraps the `Button`
 * primitive so interactive surface tokens stay owned by `Button`. Restyled to
 * the shipped HQ design language (Cue-Surfaces S6): a compact rounded pill
 * with a faint dot leader, sized to sit in a flex-wrap row rather than a
 * two-line card grid. Overrides cover layout + skin only.
 */
export interface ConversationStarterChipProps {
  /** Suggestion text. */
  label: string;
  /** Invoked when the chip is clicked (and not disabled). */
  onSelect: () => void;
  disabled?: boolean;
  /**
   * When true, the pill fills with the ink accent — the S6 "Brief me"
   * primary-suggestion treatment applied to the strongest starter.
   */
  emphasized?: boolean;
  /**
   * Optional override for the chip's accessible name. When omitted, screen
   * readers fall back to the visible `label` text.
   */
  "aria-label"?: string;
}

export const ConversationStarterChip = forwardRef<
  HTMLButtonElement,
  ConversationStarterChipProps
>(function ConversationStarterChip(
  { label, onSelect, disabled, emphasized = false, "aria-label": ariaLabel },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      disabled={disabled}
      onClick={onSelect}
      aria-label={ariaLabel}
      className={cn(
        // Override Button's fixed h-8 / default body size.
        "h-auto w-auto whitespace-nowrap",
        "gap-2 rounded-full px-3.5 py-2",
        "text-body-small-default sm:text-body-medium-lighter",
        "border",
        emphasized
          ? "border-transparent bg-[var(--mv1-t1)] [--vbtn-fg:var(--mv1-canvas)]"
          : "border-[var(--mv1-line)] bg-transparent [--vbtn-fg:var(--mv1-t2)]",
      )}
    >
      {!emphasized ? (
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-full"
          style={{ background: "var(--mv1-blue-strong)", opacity: 0.7 }}
        />
      ) : null}
      <span>{label}</span>
    </Button>
  );
});
