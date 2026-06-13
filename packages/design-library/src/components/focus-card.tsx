import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";

/**
 * FocusCard — the ink "Next move" hero. Cue's single most important surface:
 * the one thing to do next, set on the slate-ink field so it reads as the
 * focal point of the Home feed / Now rail (design-book "Home · feed").
 *
 * Theme-independent ink: uses `--surface-ink` (not `--primary-base`, which
 * inverts in dark) so the hero stays dark in every theme. Text sits on
 * `--content-on-ink`; the eyebrow + supporting copy use `--content-on-ink-muted`.
 */
export interface FocusCardProps extends Omit<ComponentProps<"div">, "title"> {
  /** Small mono kicker above the title, e.g. "Next move". */
  eyebrow?: ReactNode;
  /** The headline — the move itself. */
  title: ReactNode;
  /** Optional leading icon, rendered in the muted on-ink color. */
  icon?: ReactNode;
  /** Supporting copy below the title. */
  children?: ReactNode;
  /** Action row (buttons/chips), pinned to the end. */
  actions?: ReactNode;
}

export function FocusCard({
  eyebrow,
  title,
  icon,
  children,
  actions,
  className,
  ref,
  ...rest
}: FocusCardProps) {
  return (
    <div
      {...rest}
      ref={ref}
      data-slot="focus-card"
      className={cn(
        "flex flex-col gap-3 rounded-2xl p-5",
        "bg-[var(--surface-ink)] text-[color:var(--content-on-ink)]",
        "shadow-[var(--shadow-md)]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {icon ? (
          <span
            aria-hidden
            className="mt-0.5 flex shrink-0 items-center justify-center text-[color:var(--content-on-ink-muted)]"
          >
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {eyebrow ? (
            <span className="text-label-medium-default font-[family-name:var(--font-mono)] uppercase tracking-[0.08em] text-[color:var(--content-on-ink-muted)]">
              {eyebrow}
            </span>
          ) : null}
          <span className="text-title-small text-[color:var(--content-on-ink)]">
            {title}
          </span>
          {children ? (
            <div className="text-body-medium-lighter text-[color:var(--content-on-ink-muted)]">
              {children}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
