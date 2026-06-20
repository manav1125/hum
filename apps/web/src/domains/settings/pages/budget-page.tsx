/**
 * Budget & Spend — cost visibility + guardrails.
 *
 * Two data sources, both real:
 *   - Spend: the daemon usage totals endpoint (`usageTotalsGet`), queried for
 *     two windows — today (since local midnight) and this calendar month.
 *   - Caps / kill switch / alert threshold: the gateway budget config
 *     (`getBudgetConfig` / `setBudgetConfig`), which the daemon enforces.
 *
 * Honest states throughout: the spend figures are real; when a cap is null we
 * say "No cap set" rather than inventing a number. The gateway budget route
 * only exists after the gateway redeploys, so a failed GET shows a calm
 * "Couldn't load budget settings" error rather than crashing — spend still
 * renders from the daemon, which is independent of the gateway route.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, PauseCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { DetailCard } from "@/components/detail-card";
import { usageTotalsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  DEFAULT_BUDGET_CONFIG,
  getBudgetConfig,
  setBudgetConfig,
  type BudgetConfig,
} from "@/lib/budget-api";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { usageRangeNow } from "@/utils/usage-window";

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

/** [start, now] epoch-ms for today, since local midnight. */
function todayWindow(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  // `to` must be stable across renders or the query key churns. See usageRangeNow().
  return { from: start.getTime(), to: usageRangeNow() };
}

/** [start, now] epoch-ms for the current calendar month. */
function monthWindow(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  // `to` must be stable across renders or the query key churns. See usageRangeNow().
  return { from: start.getTime(), to: usageRangeNow() };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Spend hook
// ---------------------------------------------------------------------------

function useSpend(assistantId: string | null) {
  const today = todayWindow();
  const month = monthWindow();

  const todayQuery = useQuery({
    ...usageTotalsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { from: today.from, to: today.to },
    }),
    enabled: assistantId != null,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const monthQuery = useQuery({
    ...usageTotalsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { from: month.from, to: month.to },
    }),
    enabled: assistantId != null,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return {
    todayUsd: todayQuery.data?.totalEstimatedCostUsd ?? 0,
    monthUsd: monthQuery.data?.totalEstimatedCostUsd ?? 0,
    loading: todayQuery.isLoading || monthQuery.isLoading,
    error: todayQuery.isError || monthQuery.isError,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BudgetPage() {
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so read the
  // raw store (nullable) rather than `useActiveAssistantId()`, which throws.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const spend = useSpend(assistantId);

  const configQuery = useQuery({
    queryKey: ["budget", "config", assistantId],
    queryFn: () => getBudgetConfig(assistantId ?? ""),
    enabled: assistantId != null,
    staleTime: 30_000,
    retry: false,
  });

  // Local editable mirror of the saved config; seeded from the query, then
  // owned by the form so typing feels instant. Saves patch the gateway.
  const [config, setConfig] = useState<BudgetConfig>(DEFAULT_BUDGET_CONFIG);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (configQuery.data) setConfig(configQuery.data);
  }, [configQuery.data]);

  const persist = useCallback(
    async (patch: Partial<BudgetConfig>) => {
      if (!assistantId) return;
      setSaving(true);
      setSaveError(null);
      // Optimistic — the form already reflects the change.
      setConfig((prev) => ({ ...prev, ...patch }));
      try {
        const next = await setBudgetConfig(assistantId, patch);
        setConfig(next);
      } catch (error) {
        captureError(error, { context: "budget-config-save" });
        setSaveError(
          "Couldn't save — the budget service may be unavailable. Try again.",
        );
      } finally {
        setSaving(false);
      }
    },
    [assistantId],
  );

  const configUnavailable = configQuery.isError;

  return (
    <div className="flex flex-col gap-6">
      <SpendSummaryCard
        todayUsd={spend.todayUsd}
        monthUsd={spend.monthUsd}
        loading={spend.loading}
        error={spend.error}
      />

      {config.killSwitch && <PausedBanner />}

      {configUnavailable && <ConfigUnavailableBanner />}

      <KillSwitchCard
        killSwitch={config.killSwitch}
        disabled={!assistantId || configUnavailable || saving}
        onToggle={(killSwitch) => void persist({ killSwitch })}
      />

      <CapsCard
        config={config}
        todayUsd={spend.todayUsd}
        monthUsd={spend.monthUsd}
        disabled={!assistantId || configUnavailable}
        onSave={persist}
      />

      <AlertThresholdCard
        value={config.alertThresholdPct}
        disabled={!assistantId || configUnavailable}
        onSave={(alertThresholdPct) => void persist({ alertThresholdPct })}
      />

      {saveError && (
        <p className="text-body-small-default text-[var(--system-negative-strong)]">
          {saveError}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spend summary
// ---------------------------------------------------------------------------

function SpendSummaryCard({
  todayUsd,
  monthUsd,
  loading,
  error,
}: {
  todayUsd: number;
  monthUsd: number;
  loading: boolean;
  error: boolean;
}) {
  return (
    <DetailCard
      title="Spend"
      subtitle="Estimated AI cost from your assistant's usage. Updated continuously."
    >
      {error ? (
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          Couldn't load spend right now.
        </p>
      ) : loading ? (
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          Counting what you've spent…
        </p>
      ) : (
        <p className="text-title-medium text-[var(--content-emphasised)]">
          Spent {formatUsd(todayUsd)} today
          <span className="text-[var(--content-quiet)]"> · </span>
          {formatUsd(monthUsd)} this month
        </p>
      )}
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// Paused / unavailable banners
// ---------------------------------------------------------------------------

function PausedBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--system-negative-weak)] bg-[var(--surface-lift)] px-3 py-2.5">
      <PauseCircle className="h-4 w-4 shrink-0 text-[var(--system-negative-strong)]" />
      <span className="text-body-medium-default text-[var(--system-negative-strong)]">
        Cue is paused — no AI calls will run until you turn the kill switch off.
      </span>
    </div>
  );
}

function ConfigUnavailableBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--field-bg)] px-3 py-2.5">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--system-warning-strong)]" />
      <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
        Couldn't load budget settings. Caps and the kill switch are unavailable
        right now — your spend above is still accurate.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

function KillSwitchCard({
  killSwitch,
  disabled,
  onToggle,
}: {
  killSwitch: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <DetailCard
      title="Pause Cue"
      subtitle="An emergency stop. While paused, every AI call is blocked — nothing runs in the background, and the assistant won't respond until you resume."
    >
      <Toggle
        checked={killSwitch}
        disabled={disabled}
        onChange={onToggle}
        label={killSwitch ? "Paused — AI calls blocked" : "Running"}
      />
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// Caps + progress bars
// ---------------------------------------------------------------------------

function CapsCard({
  config,
  todayUsd,
  monthUsd,
  disabled,
  onSave,
}: {
  config: BudgetConfig;
  todayUsd: number;
  monthUsd: number;
  disabled: boolean;
  onSave: (patch: Partial<BudgetConfig>) => Promise<void>;
}) {
  return (
    <DetailCard
      title="Spend caps"
      subtitle="Set a daily or monthly ceiling. When spend reaches a cap, Cue stops making AI calls until the window resets. Leave blank for no cap."
    >
      <div className="flex flex-col gap-6">
        <CapRow
          label="Daily cap"
          windowLabel="today"
          cap={config.dailyCapUsd}
          spend={todayUsd}
          alertPct={config.alertThresholdPct}
          disabled={disabled}
          onSave={(dailyCapUsd) => onSave({ dailyCapUsd })}
        />
        <CapRow
          label="Monthly cap"
          windowLabel="this month"
          cap={config.monthlyCapUsd}
          spend={monthUsd}
          alertPct={config.alertThresholdPct}
          disabled={disabled}
          onSave={(monthlyCapUsd) => onSave({ monthlyCapUsd })}
        />
      </div>
    </DetailCard>
  );
}

function CapRow({
  label,
  windowLabel,
  cap,
  spend,
  alertPct,
  disabled,
  onSave,
}: {
  label: string;
  windowLabel: string;
  cap: number | null;
  spend: number;
  alertPct: number;
  disabled: boolean;
  onSave: (cap: number | null) => void;
}) {
  // Draft holds the raw text so the field can be cleared (= no cap) while
  // typing without the value snapping back.
  const [draft, setDraft] = useState<string>(cap == null ? "" : String(cap));

  // Re-seed when the saved cap changes from elsewhere (initial load / reset).
  useEffect(() => {
    setDraft(cap == null ? "" : String(cap));
  }, [cap]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (cap !== null) onSave(null);
      return;
    }
    const parsed = Number(trimmed);
    const next =
      Number.isFinite(parsed) && parsed > 0 ? parsed : cap; // ignore invalid
    if (next !== cap) onSave(next);
    setDraft(next == null ? "" : String(next));
  }, [draft, cap, onSave]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Input
            label={label}
            type="number"
            inputMode="decimal"
            min={0}
            step="1"
            placeholder="No cap"
            leftIcon={<span aria-hidden>$</span>}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            aria-label={`${label} in USD`}
          />
        </div>
        {cap != null && (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              setDraft("");
              onSave(null);
            }}
          >
            Clear
          </Button>
        )}
      </div>
      <CapProgress
        cap={cap}
        spend={spend}
        windowLabel={windowLabel}
        alertPct={alertPct}
      />
    </div>
  );
}

function CapProgress({
  cap,
  spend,
  windowLabel,
  alertPct,
}: {
  cap: number | null;
  spend: number;
  windowLabel: string;
  alertPct: number;
}) {
  if (cap == null) {
    return (
      <p className="text-body-small-default text-[var(--content-quiet)]">
        No cap set — Cue won't stop on its own. Enter an amount to add a ceiling.
      </p>
    );
  }

  const ratio = cap > 0 ? spend / cap : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const over = ratio >= 1;
  const warn = ratio >= alertPct / 100;

  const barColor = over
    ? "var(--system-negative-strong)"
    : warn
      ? "var(--system-warning-strong)"
      : "var(--primary-base)";

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={`${windowLabel} spend against cap`}
      >
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
      <p className="text-body-small-default text-[var(--content-tertiary)]">
        {formatUsd(spend)} of {formatUsd(cap)} {windowLabel} (
        {Math.round(ratio * 100)}%)
        {over && (
          <span className="text-[var(--system-negative-strong)]">
            {" "}
            — cap reached
          </span>
        )}
        {!over && warn && (
          <span className="text-[var(--system-warning-strong)]">
            {" "}
            — nearing cap
          </span>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alert threshold
// ---------------------------------------------------------------------------

function AlertThresholdCard({
  value,
  disabled,
  onSave,
}: {
  value: number;
  disabled: boolean;
  onSave: (pct: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = useCallback(() => {
    const parsed = Math.round(Number(draft.trim()));
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 100) {
      if (parsed !== value) onSave(parsed);
      setDraft(String(parsed));
    } else {
      setDraft(String(value));
    }
  }, [draft, value, onSave]);

  return (
    <DetailCard
      title="Alert threshold"
      subtitle="When spend reaches this percent of a cap, the progress bar turns amber and Cue flags it. Default is 80%."
    >
      <div className="w-32">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step="1"
          rightIcon={<span aria-hidden>%</span>}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          aria-label="Alert threshold percent"
        />
      </div>
    </DetailCard>
  );
}
