import { KeyRound } from "lucide-react";

import { hideVendorUi, useManagedMode } from "@/assistant/use-managed-mode";
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";

interface ProviderBillingBannerProps {
  onOpenSettings: () => void;
}

export function ProviderBillingBanner({
  onOpenSettings,
}: ProviderBillingBannerProps) {
  // Self-gating: managed (Cue-hosted) instances run on HQ-provisioned keys —
  // "add funds with your provider" is meaningless to those customers and the
  // settings page it points at is hidden in managed mode.
  const managed = useManagedMode();
  if (hideVendorUi(managed)) return null;

  return (
    <BillingErrorBanner
      ariaLabel="Your API key needs credits"
      icon={
        <KeyRound
          className="size-5"
          style={{ color: "var(--content-tertiary)" }}
        />
      }
      title="Your API key needs credits"
      subtitle="Add funds with your provider or lower the model token limit."
      ctaLabel="Open Settings"
      onAction={onOpenSettings}
    />
  );
}
