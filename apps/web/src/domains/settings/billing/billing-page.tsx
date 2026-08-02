import { ExternalLink, Loader2 } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";

import { Link, useNavigate, useSearchParams } from "react-router";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { AdjustPlanModal } from "@/domains/settings/components/adjust-plan-modal";
import { BillingPanel } from "@/domains/settings/components/billing-panel";
import { BillingPortalReturnHandler } from "@/domains/settings/components/billing-portal-return-handler";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel";
import { GracePeriodBanner } from "@/domains/settings/components/grace-period-banner";
import { PaymentMethodsCard } from "@/domains/settings/components/payment-methods-card";
import { PlanCard } from "@/domains/settings/components/plan-card";
import { ReferralPanel } from "@/domains/settings/components/referral-panel";
import { TierUpgradeResizeModal } from "@/domains/settings/components/tier-upgrade-resize-modal";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { configPlatformGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import {
  derivePlatformBillingUrl,
  platformBillingHost,
} from "@/lib/billing/platform-billing-url";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

/**
 * Handles the `billing_status` query parameter that Stripe redirects back with
 * after checkout completes (success) or is cancelled.
 */
function BillingStatusHandler() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const billingStatus = searchParams.get("billing_status");
    if (!billingStatus) return;

    if (billingStatus === "success") {
      toast.success(
        "Payment received! Your credit balance will update shortly.",
        {
          id: "billing-status",
        },
      );
      queryClient.invalidateQueries({
        queryKey: organizationsBillingSummaryRetrieveOptions().queryKey,
      });
    } else if (billingStatus === "cancel") {
      toast.info("Checkout was cancelled. No credits were added.", {
        id: "billing-status",
      });
    }

    // Clean up billing params from the URL.
    navigate(routes.settings.billing, { replace: true });
  }, [searchParams, navigate, queryClient]);

  return null;
}

/**
 * External "Manage billing on <platform>" link for the self-host billing
 * page (the `billingGate === "disabled"` branch, where no platform session
 * exists so the in-app billing UI cannot render).
 *
 * The platform base URL comes from the daemon's existing client-visible
 * config surface (`GET /v1/assistants/{id}/config/platform`, which reads
 * `platform.baseUrl`). When the daemon is unreachable, the read fails, or
 * only an internal default is reported, the link falls back to the Cue
 * platform (justcue.ai) — see `derivePlatformBillingUrl`.
 */
export function ManagePlatformBillingLink() {
  // Raw store read, not `useActiveAssistantId()`: settings routes are not
  // mounted under `<ActiveAssistantGate>`, so the id can legitimately be null
  // (e.g. a platform build with no session) — in that case the query stays
  // disabled and the link settles straight to the fallback.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const enabled = assistantId !== null;
  const { data, isPending } = useQuery({
    ...configPlatformGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Hold the link until the daemon read settles so the label never flashes
  // from the fallback host to the configured one. A disabled query never
  // settles, so it renders the fallback immediately.
  if (enabled && isPending) return null;

  const billingUrl = derivePlatformBillingUrl(data?.baseUrl);
  return (
    <a
      href={billingUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[var(--content-emphasised)] underline hover:opacity-80"
    >
      Manage billing on {platformBillingHost(billingUrl)}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

export function BillingPage() {
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingGate = usePlatformGate();
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();

  const [searchParams, setSearchParams] = useSearchParams();
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const openPlanModal = useCallback(() => setPlanModalOpen(true), []);
  const closePlanModal = useCallback(() => setPlanModalOpen(false), []);
  const [resizeModalOpen, setResizeModalOpen] = useState(false);
  const onTierUpgraded = useCallback(() => setResizeModalOpen(true), []);

  useEffect(() => {
    if (searchParams.has("adjust_plan")) {
      setPlanModalOpen(true);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("adjust_plan");
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  const hasSessionId = searchParams.has("session_id");
  const closeOnboarding = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("session_id");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // No platform behind this install, so there is no plan, no invoice and no
  // payment method to render.
  //
  // This used to `<Navigate>` to the settings index — the owner's "billing
  // points no where": the row navigated and dumped you back on the page you
  // came from. The row is disabled in the Your Cue shell now; a direct hit
  // lands here and is told why rather than being bounced.
  if (billingGate === "gated") {
    return (
      <div className="space-y-4">
        <Notice tone="info">
          <span aria-hidden>⊘ </span>
          Billing is handled on the Cue platform, and this assistant is running
          without a platform account — so there is no plan or invoice to show
          here. Spend for this assistant is on{" "}
          <Link
            to={routes.settings.budget}
            className="text-[var(--content-link)] underline hover:text-[var(--content-link-hover)]"
          >
            Usage &amp; spend
          </Link>
          .
        </Notice>
      </div>
    );
  }

  if (billingGate === "disabled") {
    return (
      <div className="space-y-4">
        <Notice tone="info">
          <div className="space-y-1.5">
            <p>Billing for this assistant is managed on the Cue platform.</p>
            <ManagePlatformBillingLink />
          </div>
        </Notice>
      </div>
    );
  }

  if (isLifecycleLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading billing…
        </div>
      </div>
    );
  }

  const showPlanManagement = isPlatformHosted;

  if (!isPlatformHosted && platformGate !== "gated") {
    return (
      <div className="space-y-4">
        <Notice tone="warning">
          Billing isn&apos;t available for the current assistant state.
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <BillingStatusHandler />
        <BillingPortalReturnHandler />
      </Suspense>
      {showPlanManagement && <GracePeriodBanner />}
      {showPlanManagement && <PlanCard onManage={openPlanModal} />}
      {showPlanManagement && (
        <AdjustPlanModal
          open={planModalOpen}
          onClose={closePlanModal}
          onTierUpgraded={onTierUpgraded}
        />
      )}
      <PaymentMethodsCard />
      <Suspense fallback={null}>
        <BillingPanel />
      </Suspense>
      <ReferralPanel />
      <BillingUsagePanel />
      {showPlanManagement && (
        <BillingOnboardingModal open={hasSessionId} onClose={closeOnboarding} />
      )}
      {showPlanManagement && (
        <TierUpgradeResizeModal
          open={resizeModalOpen}
          onClose={() => setResizeModalOpen(false)}
        />
      )}
    </div>
  );
}
