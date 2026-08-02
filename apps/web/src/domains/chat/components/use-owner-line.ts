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
  contactsGetOptions,
  usageTotalsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { GATEWAY_LOCAL_USER_ID, useAuthStore } from "@/stores/auth-store";
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

/**
 * What the row says when no source knows the owner's name.
 *
 * "You" and not a name-shaped placeholder — that distinction is the whole bug
 * this constant exists to prevent. See {@link resolveOwnerName}.
 */
export const OWNER_NAME_FALLBACK = "You";

/**
 * What the user is called, from real state, with honest fallbacks.
 *
 * ## Why this grew a second source
 *
 * The owner reported the row reading **"Local · Autonomous"**. The read was
 * resolving fine — it was resolving to a lie. A gateway/self-hosted session has
 * no platform account, so `auth-store` signs in as a synthetic
 * `gateway-local` user, and that placeholder carried `firstName: "Local"`.
 * The name half of the line was a hardcoded string all along; it just happened
 * to be one that looks like a name, which is why nobody noticed it was not one.
 *
 * The placeholder is now empty (`auth-store.ts`), and the real fallback is the
 * **guardian contact** — the daemon's own record of the human who owns this
 * assistant, of which there is exactly one by construction
 * (`assistant/src/contacts/contact-store.ts`: *"There must only ever be ONE
 * guardian — the human owner of the assistant."*). On a self-hosted instance
 * that is the only place the owner's actual name is written down.
 *
 * Order, most to least authoritative, and every step is a string the user or
 * their assistant actually stored:
 *
 *   1. the platform account's first name
 *   2. the guardian contact's display name
 *   3. the platform username
 *   4. the local part of the email — an identity, not a mailto
 *   5. `"You"` — plainly not a name, so a failed read cannot be mistaken for a
 *      successful one
 */
export function resolveOwnerName(
  user: {
    firstName?: string | null;
    username?: string | null;
    email?: string | null;
  } | null,
  guardianName?: string | null,
): string {
  const first = user?.firstName?.trim();
  if (first) return first;
  const guardian = guardianName?.trim();
  if (guardian) return guardian;
  const username = user?.username?.trim();
  if (username) return username;
  const email = user?.email?.trim();
  // The local part, not the whole address: the row is an identity, not a
  // mailto. Still the user's own string — nothing here is made up.
  if (email) {
    const local = email.split("@")[0]?.trim();
    if (local) return local;
  }
  return OWNER_NAME_FALLBACK;
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
  const rawUser = useAuthStore.use.user();
  // The gateway/self-hosted session is a placeholder, not a person: its
  // `username` is the literal string `"local"`, which would sail through
  // `resolveOwnerName` and put "local" where a name goes. Discard it whole and
  // let the guardian contact answer instead.
  const user = rawUser?.id === GATEWAY_LOCAL_USER_ID ? null : rawUser;
  const enabled = Boolean(assistantId);
  const path = { assistant_id: assistantId ?? "" };

  const profile = useQuery({
    ...companyprofileGetOptions({ path }),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

  // The daemon's own record of who owns this assistant. Shares a query key with
  // the rail's People count, so on the rail this costs no extra request.
  const contacts = useQuery({
    ...contactsGetOptions({ path }),
    enabled,
    retry: false,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const guardianName =
    contacts.data?.contacts?.find((c) => c.role === "guardian")?.displayName ??
    null;

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
    name: resolveOwnerName(user, guardianName),
    // An unrecognised mode is dropped rather than printed raw — "no raw enums"
    // (v21 §8) — and an unread one is dropped rather than defaulted.
    tier: mode ? (WORKSPACE_MODE_LABEL[mode] ?? null) : null,
    spend:
      typeof usd === "number" && Number.isFinite(usd) ? formatSpend(usd) : null,
  };
}
