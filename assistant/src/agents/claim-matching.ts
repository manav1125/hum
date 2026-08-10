/**
 * The matching engine — "what would these conditions have caught?"
 *
 * Design v39 §5: the trial, the charter dry-run, the "18 of these look like
 * Ops's job" suggestion and the store's "try it for a week" are all the SAME
 * operation. Built once, deliberately, as its own thing, so those four surfaces
 * cannot drift into four slightly different ideas of what an agent claims.
 *
 * ## Deterministic on purpose
 *
 * No model call, ever. Matching runs at intake, which is hot and already
 * fragile — an arrival-comprehension timeout on that exact path is a bug this
 * codebase has already shipped once. Every predicate here is a string or set
 * operation over fields the row already carries, so matching cannot time out,
 * cannot cost money, and cannot be unavailable.
 *
 * That is also what makes the trial honest. "It would have taken 38 things this
 * week" is only checkable if the same conditions, replayed over the same
 * intake, produce the same 38 — which a judged match could not promise.
 *
 * ## Claims are conjunctive, exclusions win
 *
 * A claim matches when EVERY stated condition holds (an unstated condition is
 * not a wildcard, it is simply not asked). Any exclusion that hits vetoes the
 * whole claim regardless. That ordering is deliberate: an agent's prohibitions
 * are the part the owner set most deliberately, and they must not be
 * out-voted by a broader positive condition somewhere else in the manifest.
 */

/** One thing an agent says it takes. All conditions must hold. */
export interface AgentClaim {
  /** Stable id, so a match can be explained by WHICH claim caught it. */
  id: string;
  /** Sender addresses, exact, case-insensitive. */
  senderAddresses?: string[];
  /** Sender domains, case-insensitive, matched on the part after "@". */
  senderDomains?: string[];
  /** Case-insensitive substrings; ANY hit satisfies this condition. */
  titleContains?: string[];
  /** Source channels, e.g. "watcher:gmail". ANY hit satisfies. */
  channels?: string[];
}

/** Conditions that veto a match no matter what else holds. */
export interface AgentExclusions {
  senderAddresses?: string[];
  senderDomains?: string[];
  titleContains?: string[];
}

/** The shape the engine needs. Deliberately narrow — anything can supply it. */
export interface MatchableItem {
  id: string;
  title: string;
  senderAddress?: string | null;
  channel?: string | null;
}

export interface ClaimMatch {
  itemId: string;
  /** Which claim caught it — the row's "why" in the trial view. */
  claimId: string;
  /**
   * The conditions that actually fired, in plain terms. The trial has to be
   * inspectable claim by claim; "it matched" with no reason is a verdict the
   * owner cannot argue with, which is the same defect as a count with no rule.
   */
  because: string[];
}

const lower = (s: string): string => s.trim().toLowerCase();

/** The part after "@", or null when the address has no domain. */
export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return lower(address.slice(at + 1));
}

function anyContains(haystack: string, needles: string[]): string | null {
  const h = lower(haystack);
  for (const n of needles) {
    const needle = lower(n);
    if (needle.length > 0 && h.includes(needle)) return n;
  }
  return null;
}

/**
 * Does an exclusion veto this item? Returns the reason, or null.
 *
 * Checked before any positive condition and independent of them, so a
 * prohibition can never be out-voted.
 */
export function exclusionReason(
  item: MatchableItem,
  ex: AgentExclusions | undefined,
): string | null {
  if (!ex) return null;
  const addr = item.senderAddress ? lower(item.senderAddress) : null;
  if (addr && ex.senderAddresses?.some((a) => lower(a) === addr)) {
    return `sender ${addr} is excluded`;
  }
  const dom = domainOf(item.senderAddress);
  if (dom && ex.senderDomains?.some((d) => lower(d) === dom)) {
    return `domain ${dom} is excluded`;
  }
  if (ex.titleContains) {
    const hit = anyContains(item.title, ex.titleContains);
    if (hit) return `title contains "${hit}", which is excluded`;
  }
  return null;
}

/**
 * Does this claim catch this item? Returns the reasons, or null.
 *
 * A claim with NO conditions matches nothing rather than everything. An empty
 * manifest is an agent that has not said what it does, and the generous
 * reading of that — "then it takes everything" — is exactly how a specialist
 * quietly becomes a second generalist with different branding.
 */
export function claimMatches(
  item: MatchableItem,
  claim: AgentClaim,
): string[] | null {
  const because: string[] = [];
  let stated = 0;

  if (claim.senderAddresses?.length) {
    stated++;
    const addr = item.senderAddress ? lower(item.senderAddress) : null;
    if (!addr || !claim.senderAddresses.some((a) => lower(a) === addr)) {
      return null;
    }
    because.push(`from ${addr}`);
  }

  if (claim.senderDomains?.length) {
    stated++;
    const dom = domainOf(item.senderAddress);
    if (!dom || !claim.senderDomains.some((d) => lower(d) === dom)) return null;
    because.push(`from ${dom}`);
  }

  if (claim.titleContains?.length) {
    stated++;
    const hit = anyContains(item.title, claim.titleContains);
    if (!hit) return null;
    because.push(`title mentions "${hit}"`);
  }

  if (claim.channels?.length) {
    stated++;
    const ch = item.channel ? lower(item.channel) : null;
    if (!ch || !claim.channels.some((c) => lower(c) === ch)) return null;
    because.push(`arrived via ${ch}`);
  }

  return stated === 0 ? null : because;
}

/**
 * Replay a manifest over real intake.
 *
 * Pure and total — no clock, no I/O, no throwing. The caller supplies the
 * window of intake it wants replayed, which is what lets the same function
 * serve a 7-day trial, a charter dry-run and a live routing decision without
 * any of them meaning something subtly different.
 *
 * First matching claim wins, so claim ORDER is policy the same way the valve's
 * rule order is: reading top to bottom tells you what beats what.
 */
export function matchIntake(
  items: MatchableItem[],
  claims: AgentClaim[],
  exclusions?: AgentExclusions,
): ClaimMatch[] {
  const out: ClaimMatch[] = [];
  for (const item of items) {
    if (exclusionReason(item, exclusions) !== null) continue;
    for (const claim of claims) {
      const because = claimMatches(item, claim);
      if (because) {
        out.push({ itemId: item.id, claimId: claim.id, because });
        break;
      }
    }
  }
  return out;
}

/**
 * What a trial can honestly report before the owner has checked anything.
 *
 * Note what is NOT here: any notion of whether the owner would have AGREED.
 * Design v39 is explicit — every trial number must be an act the owner
 * performed, never an inference, and absence of objection is never scored as
 * approval. So this counts what was claimed and nothing more; agreement is
 * supplied separately, by the owner, one check at a time.
 */
export interface TrialTally {
  /** Items the manifest claimed. */
  claimed: number;
  /** Items in the replayed window that no claim caught. */
  notClaimed: number;
}

export function tallyTrial(
  items: MatchableItem[],
  matches: ClaimMatch[],
): TrialTally {
  const claimedIds = new Set(matches.map((m) => m.itemId));
  return {
    claimed: claimedIds.size,
    notClaimed: items.filter((i) => !claimedIds.has(i.id)).length,
  };
}
