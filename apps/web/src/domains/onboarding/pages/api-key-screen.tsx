import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { hideVendorUi, useManagedMode } from "@/assistant/use-managed-mode";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
  DEFAULT_ONBOARDING_PROVIDER,
  ONBOARDING_PROVIDERS,
  onboardingProvider,
  type OnboardingProviderId,
} from "@/domains/onboarding/provider-catalog";
import {
  peekPendingProviderKey,
  setPendingProviderKey,
} from "@/domains/onboarding/provider-key";
import { isElectron } from "@/runtime/is-electron";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";

export function ApiKeyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hosting = searchParams.get("hosting");
  const electron = isElectron();

  // Managed (Cue-hosted) instances never ask for an LLM key — providers are
  // provisioned by HQ. This screen is local-mode-only so a managed instance
  // shouldn't reach it, but gate as defense in depth (renders nothing rather
  // than vendor key entry; see use-managed-mode flash policy). With no
  // active assistant selected the hook resolves to `false`, so fresh local
  // onboarding is unaffected.
  const managed = useManagedMode();

  const [provider, setProvider] = useState<OnboardingProviderId>(
    () => peekPendingProviderKey()?.provider ?? DEFAULT_ONBOARDING_PROVIDER.id,
  );
  const [apiKey, setApiKey] = useState(
    () => peekPendingProviderKey()?.key ?? "",
  );

  const entry = onboardingProvider(provider) ?? DEFAULT_ONBOARDING_PROVIDER;
  const requiresKey = entry.requiresKey;
  const canContinue = !requiresKey || apiKey.trim().length > 0;

  const onContinue = () => {
    if (!canContinue) return;
    setPendingProviderKey({
      provider,
      key: requiresKey ? apiKey.trim() : "",
    });
    void navigate(
      hosting
        ? `${routes.onboarding.privacy}?hosting=${hosting}`
        : routes.onboarding.privacy,
    );
  };

  const onBack = () => {
    void navigate(routes.onboarding.hosting);
  };

  if (hideVendorUi(managed)) return null;

  return (
    <OnboardingLayout>
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "px-6 py-16"} text-[var(--content-default)]`}
      >
        <h1
          className={
            electron
              ? "text-title-large"
              : "text-3xl font-semibold tracking-tight"
          }
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Connect a Model Provider
        </h1>
        <p
          className={`text-center text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-3"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          Enter an API key to connect your model provider.
        </p>

        <div
          className={`flex w-full flex-col gap-4 ${electron ? "mt-8" : "mt-10"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          <div className={`flex flex-col ${electron ? "gap-2" : "gap-1"}`}>
            <label className="text-body-small-default text-[var(--content-tertiary)]">
              Provider
            </label>
            <Dropdown
              aria-label="Provider"
              value={provider}
              onChange={(v) => {
                const match = onboardingProvider(v);
                if (match) {
                  setProvider(match.id);
                  setApiKey("");
                }
              }}
              options={ONBOARDING_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.displayName,
              }))}
            />
          </div>

          {requiresKey && (
            <div className="flex flex-col gap-3">
              <Input
                type="password"
                label={`${entry.displayName} API Key`}
                placeholder={entry.apiKeyPlaceholder ?? "Enter your API key"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                fullWidth
              />
              {entry.docsUrl && (
                <p className="self-start text-body-medium-lighter text-[var(--content-tertiary)]">
                  Don't have it?{" "}
                  <a
                    href={entry.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--content-default)] underline"
                  >
                    Get an API key here
                  </a>
                </p>
              )}
            </div>
          )}
        </div>

        <div
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!canContinue}
            onClick={onContinue}
            className={electron ? undefined : "h-11 text-base"}
          >
            Continue
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={onBack}
            className={electron ? undefined : "h-11 text-base"}
          >
            Back
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
