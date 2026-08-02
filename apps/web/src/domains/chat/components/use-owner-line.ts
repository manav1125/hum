/**
 * `👤 Manav · Autonomous · $4.10` — the rail's account line.
 *
 * Design's sidebar footer is the owner's **name**, the autonomy tier and the
 * spend, and it is the door to Trust / Preferences / Billing. The shipped build
 * had a row labelled "Preferences" instead, which is the mechanism rather than
 * the person, and the owner read it as the settings pages having been removed.
 *
 * ## Three reads, three honest failures
 *
 * The name is the one that matters. **It is never a hardcoded string** — it
 * comes from the signed-in user, and when there is no name on file it falls
 * back through progressively less personal but still TRUE things (username,
 * the local part of the email) before landing on "You". Inventing a plausible
 * name for a row whose whole job is to say whose workspace this is would be the
 * worst possible small lie.
 *
 * The tier and the spend are **omitted entirely when they cannot be read**,
 * rather than defaulting. A default autonomy tier would misreport what Cue is
 * allowed to do unattended, and `$0.00` when the number is merely unfetched is
 * the "never a fake number" invariant exactly. A line that reads `👤 Manav` is
 * the honest form of a line that cannot read the other two.
 *
 * Split into its own module so the pure parts are testable without a query
 * client, and so the menu that renders it can be tested without standing up
 * the generated daemon client.
 */
import { useQuery } from "@tanstack/react-query";

import {
  companyprofileGetOptions,
  usageTotalsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useAuthStore } from "@/stores/auth-store";
import { usageRangeNow } from "@/utils/usage-window";

/** The three workspace postures, in the words design uses for them. */
export const WORKSPACE_MODE_LABEL: Record<string, string> = {
  observe: "Observe",
  assist: "Assist",
  autonomous: "Autonomous",
};

export interface OwnerLine {
  /** Always present. Never invented — see the module header. */
  name: string;
  /** `null` when the workspace posture could not be read. */
  tier: string | null;
  /** `null` when spend could not be read. Formatted, e.g. `$4.10`. */
  spend: string | null;
}

/** What the user is called, from real state, with honest fallbacks. */
export function resolveOwnerName(
  user: {
    firstName?: string | null;
    username?: string | null;
    email?: string | null;
  } | null,
): string {
  const first = user?.firstName?.trim();
  if (first) return first;
  const username = user?.username?.trim();
  if (username) return username;
  const email = user?.email?.trim();
  // The local part, not the whole address: the row is an identity, not a
  // mailto. Still the user's own string — nothing here is made up.
  if (email) {
    const local = email.split("@")[0]?.trim();
    if (local) return local;
  }
  return "You";
}

/** `$4.10`. Two decimals always, so the row's width does not jitter. */
export function formatSpend(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** The rendered line, skipping whatever could not be read. */
export function ownerLineText(line: OwnerLine): string {
  return [line.name, line.tier, line.spend].filter(Boolean).join(" · ");
}

/** Month to date, with a stable upper bound — see `usageRangeNow`. */
function monthWindow(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { from: start.getTime(), to: usageRangeNow() };
}

export function useOwnerLine(assistantId?: string | null): OwnerLine {
  const user = useAuthStore.use.user();
  const enabled = Boolean(assistantId);
  const path = { assistant_id: assistantId ?? "" };

  const profile = useQuery({
    ...companyprofileGetOptions({ path }),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const month = monthWindow();
  const usage = useQuery({
    ...usageTotalsGetOptions({ path, query: month }),
    enabled,
    retry: false,
    staleTime: 60_000,
  });

  const mode = profile.data?.profile?.workspaceMode;
  const usd = usage.data?.totalEstimatedCostUsd;

  return {
    name: resolveOwnerName(user),
    // An unrecognised mode is dropped rather than printed raw — "no raw enums"
    // (v21 §8) — and an unread one is dropped rather than defaulted.
    tier: mode ? (WORKSPACE_MODE_LABEL[mode] ?? null) : null,
    spend:
      typeof usd === "number" && Number.isFinite(usd) ? formatSpend(usd) : null,
  };
}
