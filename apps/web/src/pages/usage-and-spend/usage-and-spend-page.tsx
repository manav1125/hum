/**
 * **Usage & spend** — the one page that answers "what is this costing me".
 *
 * Design's fourth duplication: a standalone Usage page under Logs held the
 * trend chart and the per-call-site breakdown, while Settings → Budget & Spend
 * held the totals, the caps and the kill switch. Two pages, one question — and
 * the worse half of the split was that a cap you cannot explain is a number
 * rather than a control.
 *
 * The two halves live in two domains (`settings` owns the caps, `logs` owns the
 * analytics) and a domain may not import across, so this page — outside both —
 * is where they are composed. That is the escape hatch CONVENTIONS.md names for
 * exactly this case.
 *
 * `/assistant/logs/usage` redirects here **preserving its query string**, which
 * is what keeps the schedule detail's "View usage" deep link
 * (`?range=7d&groupBy=schedule&scheduleId=…`) landing on the right filter:
 * `UsageTab` reads its whole state from the URL.
 */

import { UsageTab } from "@/domains/logs/components/usage-tab";
import { BudgetPage } from "@/domains/settings/pages/budget-page";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function UsageAndSpendPage() {
  // Caps first, then the breakdown that justifies them: you arrive here either
  // to set a limit or to find out why one was hit, and the limit is the
  // shorter answer.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  return (
    <div className="flex flex-col gap-6">
      <BudgetPage />
      {assistantId ? (
        <div className="border-t border-[var(--border-base)] pt-6">
          <UsageTab assistantId={assistantId} />
        </div>
      ) : null}
    </div>
  );
}
