import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "@vellumai/design-library";
import { decisionStatusPresentation } from "@/domains/chat/utils/decision-status";
import type { Surface } from "@/domains/chat/types/types";

interface SurfaceContainerProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
  hideTitle?: boolean;
  children: ReactNode;
}

export function SurfaceContainer({
  surface,
  onAction,
  hideTitle,
  children,
}: SurfaceContainerProps) {
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);

  const handleAction = async (actionId: string) => {
    setSubmittingAction(actionId);
    try {
      const actionData = surface.actions?.find((a) => a.id === actionId)?.data;
      await onAction(surface.surfaceId, actionId, actionData);
    } finally {
      setSubmittingAction(null);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
      {!hideTitle && surface.title && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-title-small text-[var(--content-strong)]">
            {surface.title}
          </span>
        </div>
      )}

      <div>{children}</div>

      {surface.completed
        ? surface.completionSummary &&
          (() => {
            // Decided-card treatment (design ruling 5): the status line
            // replaces the buttons in place — card content stays above —
            // with the shared wording and the in-app glyph per state
            // (Approved ✓ green · Denied ✕ red · Expired ◷ grey).
            const { Icon, textClass } = decisionStatusPresentation(
              surface.completionSummary,
            );
            return (
              <div className="mt-4 flex justify-end">
                <span
                  className={`flex items-center gap-1.5 text-body-medium-default ${textClass}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {surface.completionSummary}
                </span>
              </div>
            );
          })()
        : surface.actions &&
          surface.actions.length > 0 && (
            <div className="mt-4 flex gap-2">
              {surface.actions.map((action) => (
                <Button
                  key={action.id}
                  variant={action.style === "primary" ? "primary" : "outlined"}
                  disabled={submittingAction !== null}
                  onClick={() => handleAction(action.id)}
                  leftIcon={
                    submittingAction === action.id ? (
                      <Loader2 className="animate-spin" />
                    ) : undefined
                  }
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
    </div>
  );
}
