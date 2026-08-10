/**
 * The agent manifest — what an agent says it takes, needs, and will never do.
 *
 * Design v39, build order step 2. One shape for every agent, however it got
 * here: created on demand ("make me an invoices agent"), shipped pre-built, or
 * installed from the store later. If those diverge, the trial and the store
 * end up describing different things and the owner cannot compare them.
 *
 * ## The three questions, and why only three
 *
 * Creation asks exactly three things and stops, because each is something that
 * CANNOT be inferred from the owner's data:
 *
 *   1. what counts as one worth its attention  → {@link AgentManifest.claims}
 *   2. what must it never do on its own        → `prohibitions`
 *   3. is <this ambiguous case> a decision      → `handsBackAlways`
 *
 * Everything else — how often, from whom, what it costs — is observable, and
 * asking about it would be a form the owner fills in for us.
 *
 * ## What a manifest may NOT contain
 *
 * **No provider.** An agent declares a capability tier and nothing about who
 * serves it: the owner ruled provider names out of the product, and an agent
 * advertising "powered by X" would make quality legible as model choice rather
 * than harness quality — the opposite of where competition should sit.
 *
 * **No granted authority.** `asks` is what the agent WANTS. What it actually
 * gets lives with the owner's grant, never here, so a manifest — including one
 * that arrived from a third party — can never widen its own permissions by
 * being re-read. An agent asks; the owner grants; the two are different
 * records on purpose.
 *
 * **No spend it can enforce.** `asks.weeklyBudgetCents` is a request. The cap
 * is the owner's and is enforced by the budget engine, so an installed agent
 * cannot set the number that bounds it.
 */

import type { AgentClaim, AgentExclusions } from "./claim-matching.js";

/**
 * Capability tiers, in the owner's vocabulary.
 *
 * Deliberately NOT the word "tier" anywhere it meets autonomy in the UI: that
 * word is already shipped for the autonomy ladder ("Tier 3 · acts in budget"),
 * and design ruled autonomy keeps it. This is the model-capability axis and it
 * gets the Cue-branded words instead.
 */
export type CapabilityTier = "everyday" | "deep";

/** How much an agent may do without being asked. Design's autonomy ladder. */
export type AutonomyTier = "suggests" | "acts_tells_you" | "acts_in_budget";

/** Who wrote this agent. A source line, never a badge — see `provenance`. */
export type AgentProvenance = "cue" | "owner" | "third_party";

export interface AgentAsks {
  /**
   * Connector scopes the agent needs, e.g. "gmail.send". Each is separately
   * withhold-able by the owner, and a withheld scope must state what the agent
   * does instead — that sentence is what makes partial grants usable rather
   * than a schema nobody touches.
   */
  scopes: string[];
  /** The capability tier it wants to run at. */
  capability: CapabilityTier;
  /** The weekly spend it is ASKING for. Never what it gets. */
  weeklyBudgetCents: number;
  /** The autonomy it is asking for. Never what it gets. */
  autonomy: AutonomyTier;
}

export interface AgentManifest {
  id: string;
  /** What the owner calls it. */
  name: string;
  /**
   * One sentence, in the owner's words, of what it takes on. Shown beside the
   * conditions so a claim can be read without parsing tags — and so a
   * mismatch between the sentence and the rules is visible rather than buried.
   */
  claimsSentence: string;
  /** The deterministic conditions. Order is policy: first match wins. */
  claims: AgentClaim[];
  /**
   * Things it must never touch. PERMANENT and tier-independent — a thing the
   * owner said "never" about must not quietly become possible at a higher
   * autonomy. Enforced ahead of every positive condition in the matcher.
   */
  prohibitions: AgentExclusions;
  /**
   * Kinds of work it always hands back rather than doing. Distinct from
   * prohibitions: a prohibition means "not yours at all", a hand-back means
   * "yours to notice, mine to decide". Conflating them is how an owner loses
   * track of which things an agent is choosing not to do.
   */
  handsBackAlways: string[];
  asks: AgentAsks;
  provenance: AgentProvenance;
  /**
   * Skills it may reach for. The count against the total is the sentence that
   * justifies specialists existing at all — "6 of 98" is the context-economy
   * argument made visible exactly where someone would otherwise ask "why not
   * just use Cue?".
   */
  skills: string[];
}

/**
 * The generalist: the agent that owns anything nobody else claims.
 *
 * It exists as a real manifest rather than as a null case because
 * `work_items.assignee` is already the literal string "cue" on every item —
 * the generalist has been owning all the work since the beginning, we just
 * never modelled it. Giving it a row makes the existing data correct instead
 * of requiring a migration.
 *
 * No claims, deliberately: it is not selected by matching, it is the fallback
 * when matching selects nobody. That is also why it must never be reachable
 * through {@link matchIntake} — an empty claim list matches nothing there, so
 * the two rules agree.
 */
export const GENERALIST_ID = "cue";

export function generalistManifest(): AgentManifest {
  return {
    id: GENERALIST_ID,
    name: "Cue",
    claimsSentence: "Anything no specialist has claimed.",
    claims: [],
    prohibitions: {},
    handsBackAlways: [],
    asks: {
      scopes: [],
      capability: "everyday",
      weeklyBudgetCents: 0,
      autonomy: "suggests",
    },
    provenance: "cue",
    skills: [],
  };
}

/** Why a manifest was rejected. Each is a thing the owner must be told. */
export type ManifestProblem =
  | "no_name"
  | "no_claims_sentence"
  | "no_claims"
  | "empty_claim"
  | "negative_budget"
  | "third_party_over_autonomy";

/**
 * The autonomy ceiling a third-party agent may ask for before it has a record.
 *
 * Design v39: third-party agents cannot be granted above "acts, tells you"
 * until they have worked a month. Enforced at the ASK as well as the grant, so
 * an installed manifest cannot even present itself as wanting full autonomy on
 * day one — the owner should not be offered a choice we would refuse.
 */
export const THIRD_PARTY_MAX_ASK: AutonomyTier = "acts_tells_you";

const AUTONOMY_ORDER: AutonomyTier[] = [
  "suggests",
  "acts_tells_you",
  "acts_in_budget",
];

export function autonomyRank(a: AutonomyTier): number {
  return AUTONOMY_ORDER.indexOf(a);
}

/**
 * Validate a manifest before it is stored or trialled.
 *
 * Returns every problem, not the first — an owner fixing an agent should see
 * the whole list once rather than discover them one rejection at a time.
 *
 * The generalist is exempt from the claims checks BY ID, not by shape: it is
 * the only agent allowed to have no claims, and making that an explicit
 * exception keeps "no claims" an error for everyone else rather than a hole.
 */
export function validateManifest(m: AgentManifest): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  if (!m.name.trim()) problems.push("no_name");

  if (m.id !== GENERALIST_ID) {
    if (!m.claimsSentence.trim()) problems.push("no_claims_sentence");
    if (m.claims.length === 0) problems.push("no_claims");
    // A claim with no conditions matches nothing in the engine, so it is dead
    // weight the owner would reasonably expect to do something. Caught here
    // rather than silently ignored at match time.
    const hasEmpty = m.claims.some(
      (c) =>
        !c.senderAddresses?.length &&
        !c.senderDomains?.length &&
        !c.titleContains?.length &&
        !c.channels?.length,
    );
    if (hasEmpty) problems.push("empty_claim");
  }

  if (m.asks.weeklyBudgetCents < 0) problems.push("negative_budget");

  if (
    m.provenance === "third_party" &&
    autonomyRank(m.asks.autonomy) > autonomyRank(THIRD_PARTY_MAX_ASK)
  ) {
    problems.push("third_party_over_autonomy");
  }

  return problems;
}

/**
 * The "6 of 98 skills" sentence.
 *
 * Rendered wherever an agent is being weighed against just using Cue, because
 * that is the moment the context-economy argument has to land: a specialist is
 * not a better model, it is a smaller problem.
 */
export function skillsSentence(m: AgentManifest, totalSkills: number): string {
  return `${m.skills.length} of ${totalSkills} skills`;
}
