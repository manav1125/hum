/**
 * BudgetCapProvider — daemon-enforced spend cap + kill switch.
 *
 * A provider decorator that, BEFORE every `inner.sendMessage`, checks the
 * gateway-owned budget config (caps + kill switch) against the current day and
 * month spend windows. When the user has positively configured a cap that is
 * reached, or has flipped the kill switch on, the call is BLOCKED by throwing a
 * typed {@link BudgetCapError} with a user-facing message.
 *
 * WIRING: this decorator sits OUTSIDE `UsageTrackingProvider` in the chain
 * (`BudgetCapProvider(UsageTrackingProvider(...))`), so a blocked call never
 * reaches usage tracking and records nothing — the throw happens before any
 * spend is incurred.
 *
 * ── FAIL-OPEN CONTRACT (critical) ──────────────────────────────────────────
 * If the budget config read OR the spend query throws / transiently fails, we
 * FAIL OPEN: the call is allowed and a warning is logged. We NEVER brick the
 * assistant on a transient read error. The cap only BLOCKS when it positively
 * knows that spend ≥ cap, or that killSwitch === true. The config reader caches
 * the last-known config so a flapping gateway can't silently disable an
 * already-configured cap (see budget-config-reader.ts).
 *
 * ── ALERTS ─────────────────────────────────────────────────────────────────
 * When day or month spend crosses `alertThresholdPct`% of its cap, one
 * notification is emitted per window (deduped by a per-window key) so it fires
 * once, not on every call.
 */

import { getTotalUsageCostInWindow } from "../memory/llm-usage-store.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { getLogger } from "../util/logger.js";
import {
  type BudgetConfig,
  getBudgetConfig,
} from "./budget-config-reader.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "./types.js";

const log = getLogger("provider-budget-cap");

/**
 * Thrown when a budget cap is reached or the kill switch is on. Carries a
 * user-facing `message` suitable for surfacing directly in the UI.
 */
export class BudgetCapError extends Error {
  /** Which limit tripped: a daily/monthly cap, or the manual kill switch. */
  public readonly kind: "daily" | "monthly" | "killSwitch";

  constructor(kind: "daily" | "monthly" | "killSwitch", message: string) {
    super(message);
    this.name = "BudgetCapError";
    this.kind = kind;
    Object.setPrototypeOf(this, BudgetCapError.prototype);
  }
}

// ── Spend windows ────────────────────────────────────────────────────────────

/** [start, end) epoch-ms bounds of the current local-midnight day. */
export function currentDayWindow(now: Date = new Date()): {
  from: number;
  to: number;
} {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.getTime(), to: end.getTime() };
}

/** [start, end) epoch-ms bounds of the current calendar month (local time). */
export function currentMonthWindow(now: Date = new Date()): {
  from: number;
  to: number;
  /** Stable key identifying this month, e.g. "2026-06". */
  key: string;
} {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { from: start.getTime(), to: end.getTime(), key };
}

function dayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export class BudgetCapProvider implements Provider {
  public readonly name: string;
  public readonly tokenEstimationProvider?: string;

  // In-process dedup of alerts: tracks the window key we last alerted for, per
  // scope. The notification pipeline also dedups via `dedupeKey`, but this
  // avoids re-emitting (and re-querying) on every call within a hot burst.
  private alertedDayKey: string | null = null;
  private alertedMonthKey: string | null = null;

  constructor(private readonly inner: Provider) {
    this.name = inner.name;
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    await this.enforceBudget();
    return this.inner.sendMessage(messages, options);
  }

  /**
   * Evaluate the budget BEFORE the wrapped call. Throws {@link BudgetCapError}
   * to block when a cap is reached or the kill switch is on. Returns normally
   * (allowing the call) in every other case — including any read/query error
   * (FAIL OPEN).
   */
  private async enforceBudget(): Promise<void> {
    let config: BudgetConfig;
    try {
      config = await getBudgetConfig();
    } catch (err) {
      // FAIL OPEN — never brick the assistant on a transient config read error.
      log.warn(
        { err: String(err) },
        "Budget config read failed — failing open (allowing call)",
      );
      return;
    }

    // Kill switch is a positive, explicit user action — block immediately. No
    // spend query needed.
    if (config.killSwitch) {
      throw new BudgetCapError(
        "killSwitch",
        "Cue is paused — the budget kill switch is on. Resume in Settings → Budget.",
      );
    }

    // No caps configured → nothing to enforce or alert on. Skip the spend
    // queries entirely (the common default-OFF case).
    if (config.dailyCapUsd == null && config.monthlyCapUsd == null) {
      return;
    }

    const now = new Date();

    // Daily cap.
    if (config.dailyCapUsd != null) {
      const { from, to } = currentDayWindow(now);
      const daySpend = this.readSpendOrFailOpen(from, to, "day");
      if (daySpend === null) return; // query failed → fail open
      if (daySpend >= config.dailyCapUsd) {
        throw new BudgetCapError(
          "daily",
          `Cue is paused — your $${formatUsd(config.dailyCapUsd)} daily budget is reached. Raise it or resume in Settings → Budget.`,
        );
      }
      this.maybeAlert(
        "daily",
        daySpend,
        config.dailyCapUsd,
        config.alertThresholdPct,
        dayKey(now),
      );
    }

    // Monthly cap.
    if (config.monthlyCapUsd != null) {
      const { from, to, key } = currentMonthWindow(now);
      const monthSpend = this.readSpendOrFailOpen(from, to, "month");
      if (monthSpend === null) return; // query failed → fail open
      if (monthSpend >= config.monthlyCapUsd) {
        throw new BudgetCapError(
          "monthly",
          `Cue is paused — your $${formatUsd(config.monthlyCapUsd)} monthly budget is reached. Raise it or resume in Settings → Budget.`,
        );
      }
      this.maybeAlert(
        "monthly",
        monthSpend,
        config.monthlyCapUsd,
        config.alertThresholdPct,
        key,
      );
    }
  }

  /**
   * Read cumulative spend for a window. On a DB error, log and return `null`
   * so the caller fails OPEN rather than blocking on a transient query error.
   */
  private readSpendOrFailOpen(
    from: number,
    to: number,
    scope: "day" | "month",
  ): number | null {
    try {
      return getTotalUsageCostInWindow(from, to);
    } catch (err) {
      log.warn(
        { err: String(err), scope },
        "Budget spend query failed — failing open (allowing call)",
      );
      return null;
    }
  }

  /**
   * Emit a one-time alert when spend crosses the threshold for a window. Deduped
   * both in-process (per window key) and via the pipeline's `dedupeKey`.
   */
  private maybeAlert(
    scope: "daily" | "monthly",
    spend: number,
    cap: number,
    alertThresholdPct: number,
    windowKey: string,
  ): void {
    const thresholdUsd = (cap * alertThresholdPct) / 100;
    if (spend < thresholdUsd) return;

    const alreadyAlerted =
      scope === "daily"
        ? this.alertedDayKey === windowKey
        : this.alertedMonthKey === windowKey;
    if (alreadyAlerted) return;

    if (scope === "daily") {
      this.alertedDayKey = windowKey;
    } else {
      this.alertedMonthKey = windowKey;
    }

    const pct = Math.round((spend / cap) * 100);
    const label = scope === "daily" ? "daily" : "monthly";
    // Fire-and-forget — alert delivery must never block or fail the LLM call.
    void emitNotificationSignal({
      sourceEventName: "budget.alert",
      sourceChannel: "watcher",
      sourceContextId: `budget:${scope}:${windowKey}`,
      dedupeKey: `budget-alert:${scope}:${windowKey}`,
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
      contextPayload: {
        scope,
        spendUsd: spend,
        capUsd: cap,
        percentUsed: pct,
        title: "Budget alert",
        body: `You've used $${formatUsd(spend)} of your $${formatUsd(cap)} ${label} budget (${pct}%). Cue will pause at 100%.`,
      },
    }).catch((err) => {
      log.warn({ err: String(err), scope }, "Failed to emit budget alert");
    });
  }
}

function formatUsd(value: number): string {
  // Whole dollars when integral, otherwise two decimals.
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
