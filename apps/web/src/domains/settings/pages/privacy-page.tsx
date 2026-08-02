import { useState } from "react";
import { Link } from "react-router";

import { settingsClientPut } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { DetailCard } from "@/components/detail-card";
import { SystemPermissionsCard } from "@/components/system-permissions-card";
import { AccessConsentSetting } from "@/domains/settings/components/access-consent-setting";
import { BiometricSettingsCard } from "@/domains/settings/components/biometric-settings-card";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useHasPlatformSession } from "@/stores/auth-store";
import {
  getDeviceBool,
  getDeviceSetting,
  setDeviceSetting,
} from "@/utils/device-settings";
import { savePreferenceToggle } from "@/utils/onboarding-cleanup";
import { routes } from "@/utils/routes";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Toggle } from "@vellumai/design-library/components/toggle";

const RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: "dontRetain", label: "Don't retain" },
  { value: "oneHour", label: "1 hour" },
  { value: "oneDay", label: "1 day" },
  { value: "sevenDays", label: "7 days" },
  { value: "thirtyDays", label: "30 days" },
  { value: "ninetyDays", label: "90 days" },
  { value: "keepForever", label: "Keep forever" },
];

const DEFAULT_RETENTION_ID = "thirtyDays";

// Generic client key/value store key the retention choice persists under.
const LLM_LOG_RETENTION_KEY = "llmLogRetention";

function SettingRow({
  label,
  helperText,
  checked,
  onChange,
}: {
  label: string;
  helperText: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="text-body-medium-default text-[var(--content-default)]">
          {label}
        </div>
        <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
          {helperText}
        </p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Divider() {
  return (
    <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
  );
}

export function PrivacyPage() {
  // platformHostedOnly so the divider visibility matches the gate inside
  // `AccessConsentSetting` exactly.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const hasPlatformSession = useHasPlatformSession();
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so read the
  // raw store (nullable) rather than `useActiveAssistantId()`, which throws.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [shareAnalytics, setShareAnalytics] = useState(() =>
    getDeviceBool("shareAnalytics", true),
  );
  const [shareDiagnostics, setShareDiagnostics] = useState(() =>
    getDeviceBool("shareDiagnostics", true),
  );
  const [retentionId, setRetentionId] = useState(() =>
    getDeviceSetting("llmLogRetention", DEFAULT_RETENTION_ID),
  );

  const handleAnalyticsToggle = () => {
    const next = !shareAnalytics;
    setShareAnalytics(next);
    savePreferenceToggle("share_analytics", next, hasPlatformSession);
  };

  const handleDiagnosticsToggle = () => {
    const next = !shareDiagnostics;
    setShareDiagnostics(next);
    savePreferenceToggle("share_diagnostics", next, hasPlatformSession);
  };

  const handleRetentionChange = (value: string) => {
    setRetentionId(value);
    // Device setting stays the instant-UI cache the renderer reads on mount.
    setDeviceSetting(LLM_LOG_RETENTION_KEY, value);
    // Also persist to the daemon via the generic client key/value store so the
    // choice survives a cache clear and is visible to other clients.
    // Best-effort: the cache already reflects the change.
    if (assistantId) {
      void settingsClientPut({
        path: { assistant_id: assistantId },
        body: { key: LLM_LOG_RETENTION_KEY, value },
        throwOnError: true,
      }).catch((error) => {
        captureError(error, { context: "settings-llm-log-retention" });
      });
    }
  };

  return (
    <div className="space-y-4">
      <BiometricSettingsCard />
      <SystemPermissionsCard />
      {/*
        `TrustRules`, `AutonomySettings` and `RiskToleranceSettings` used to
        render here as well. They are Guardrails — checkpoints, agent scopes,
        autonomy and trust rules — and having them in two places meant two
        surfaces could disagree about what Cue is allowed to do unattended,
        which is the one disagreement this app cannot afford. They now live
        only at `/assistant/guardrails`, and the row below is the way there.

        What stays is what design drew the line around: *"System grants stay
        separate — those are macOS permissions, not policy."* An OS grant is
        something the Mac decides and you can only ask for; a trust rule is
        something you decide. Different lifecycles, so by design's own merging
        test they do not merge.
      */}
      <GuardrailsPointer />
      <DetailCard title="Privacy">
        <div className="space-y-4">
          <SettingRow
            label="Share Analytics"
            helperText="Send anonymous product usage data. Your conversations and personal data are never included."
            checked={shareAnalytics}
            onChange={handleAnalyticsToggle}
          />
          <Divider />
          <SettingRow
            label="Share Diagnostics"
            helperText="Send crash reports and performance metrics. Your conversations and personal data are never included."
            checked={shareDiagnostics}
            onChange={handleDiagnosticsToggle}
          />
          <Divider />
          <AccessConsentSetting />
          {/*
            `AccessConsentSetting` returns null when gated (self-hosted
            assistants). Hide the trailing divider in that case so we
            don't render two adjacent dividers around a missing row.
          */}
          {platformGate !== "gated" && <Divider />}
          <div>
            <label
              htmlFor="llm-log-retention"
              className="block text-body-medium-default text-[var(--content-default)]"
            >
              LLM Request Log Retention
            </label>
            <div className="mt-2" style={{ maxWidth: 280 }}>
              <Dropdown
                value={retentionId}
                onChange={handleRetentionChange}
                options={RETENTION_OPTIONS}
              />
            </div>
            <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
              How long to keep LLM request and response logs on this device.
              These logs record the prompts and completions sent to model
              providers and are used for debugging. Shorter retention improves
              privacy; longer retention helps troubleshoot issues.
            </p>
          </div>
        </div>
      </DetailCard>
    </div>
  );
}

/**
 * The one row left where the autonomy controls used to be.
 *
 * A cross-link rather than a silent removal: three cards vanishing from a page
 * someone has used before is indistinguishable from a regression unless the
 * page says where they went. It is not a second nav path either — it is a
 * pointer on the surface that lost them, not an entry in any navigation.
 */
function GuardrailsPointer() {
  return (
    <DetailCard title="Autonomy & trust rules">
      <p className="text-body-medium-default text-[var(--content-secondary)]">
        Checkpoints, agent scopes, autonomy level and trust rules all live in
        Guardrails now — one place, so two surfaces can't disagree about what
        Cue may do on its own.
      </p>
      <Link
        to={routes.guardrails}
        className="mt-3 inline-flex items-center gap-1 text-body-medium-default text-[var(--primary-active)] underline-offset-2 hover:underline"
      >
        Open Guardrails
        <span aria-hidden>›</span>
      </Link>
    </DetailCard>
  );
}
