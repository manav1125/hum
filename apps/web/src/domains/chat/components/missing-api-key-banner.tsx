import { X } from "lucide-react";

import { hideVendorUi, useManagedMode } from "@/assistant/use-managed-mode";
import { Button } from "@vellumai/design-library";

export interface MissingApiKeyBannerProps {
  onOpenSettings: () => void;
  onDismiss: () => void;
}

export function MissingApiKeyBanner({
  onOpenSettings,
  onDismiss,
}: MissingApiKeyBannerProps) {
  // Self-gating: on managed (Cue-hosted) instances keys are provisioned by
  // HQ — a missing/invalid key is an ops incident, not something the
  // customer can fix, and the banner would point at a settings page that is
  // hidden in managed mode. Gated here (rather than in each parent) so every
  // render path is covered.
  const managed = useManagedMode();
  if (hideVendorUi(managed)) return null;

  return (
    <div
      className="relative flex flex-col gap-3 bg-[var(--surface-active)] p-4"
      style={{ borderRadius: "10px 10px 0 0" }}
      role="status"
      aria-label="API key required"
      data-testid="missing-api-key-banner"
    >
      <div className="absolute right-2 top-2">
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          tooltip="Dismiss"
          aria-label="Dismiss API key required alert"
          onClick={onDismiss}
        />
      </div>

      <div className="flex flex-col gap-2 pr-8">
        <p className="text-body-small-emphasised text-[var(--content-default)]">
          API key required
        </p>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          Add an API key in Settings → Models & Services to start chatting.
        </p>
      </div>

      <Button variant="primary" onClick={onOpenSettings}>
        Open Settings
      </Button>
    </div>
  );
}
