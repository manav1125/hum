import type { ReactNode } from "react";

import { cn } from "@vellumai/design-library";

/**
 * Shared rounded-overlay container for the assistant's main content pages
 * (Intelligence "About Assistant" tabs, Library). Keeps the surface,
 * border, padding, and min-h-0 flex behavior consistent across pages so
 * children only own their per-page header/body layout.
 *
 * On mobile (max-md) the rounded "floating panel" chrome is dropped so the
 * page fills the viewport edge-to-edge instead of reading as a card with
 * gaps around it.
 */
export function PageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-6 py-5",
        "max-md:rounded-none max-md:border-0 max-md:px-4 max-md:py-3",
        // Full-bleed on mobile → the page header must clear the iOS status
        // bar itself (resolves to +0px in browsers/desktop).
        "max-md:pt-[calc(12px+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
        className,
      )}
    >
      {children}
    </div>
  );
}
