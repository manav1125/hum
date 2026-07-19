/**
 * Auto-triage + policy-gated auto-run for freshly captured work items.
 *
 * Closes the capture → execution gap: today items land in the queue at the
 * default priority and wait for a manual "Run it". This module runs right
 * after capture (fire-and-forget from every creation callsite) and does two
 * things:
 *
 *   1. TRIAGE — score urgency with the flash LLM (same side-chain path
 *      next-move narration uses) and stamp `priorityTier` (0/1/2) plus
 *      `sortIndex` (100 - urgency) so the queue is genuinely ranked, not
 *      insertion-ordered. Falls back to a deterministic keyword heuristic
 *      when no provider is configured or the call fails. Items whose caller
 *      explicitly chose a priority are left alone.
 *
 *   2. AUTO-RUN — when the user's per-category autonomy policy allows it,
 *      hand the item straight to the background runner instead of parking it
 *      in the queue. The gate is deterministic: every tool in the item's
 *      `requiredTools` snapshot is classified via `classifyAutonomy` and the
 *      item auto-runs only if EVERY class resolves to "auto" under the
 *      current policy (an item with no snapshot classifies as "other").
 *      Money/delete therefore wait for a human under the default Balanced
 *      policy, and everything defers — never denies — when the policy says
 *      ask. A concurrency cap keeps a burst of captures from stampeding the
 *      daemon, and CUE_DISABLE_WORKITEM_AUTORUN turns the behavior off
 *      entirely.
 *
 * Triage failures are non-fatal by design: the item stays queued exactly as
 * it would have before this module existed.
 */

import { getDisableWorkItemAutoRun } from "../config/env-registry.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import {
  type AutonomyClass,
  classifyAutonomy,
} from "../permissions/autonomy-class.js";
import { getAutonomyPolicy } from "../permissions/autonomy-policy-reader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import { listProjects, type Project } from "./project-store.js";
import { findAuthorizingStandingRule } from "./standing-rules-store.js";
import {
  broadcastWorkItemStatus,
  runWorkItemInBackground,
} from "./work-item-runner.js";
import {
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

const log = getLogger("work-item-triage");

/** Never let auto-run start more than this many concurrent background runs. */
const MAX_AUTO_CONCURRENT_RUNS = 2;

/** Flash-LLM triage must not dawdle — fall back to heuristics past this. */
const TRIAGE_TIMEOUT_MS = 8_000;

export interface TriageOptions {
  /**
   * True when the creator (user or main-agent tool call) explicitly chose a
   * priority — triage then leaves priorityTier untouched and only fills in
   * the urgency-derived sortIndex when one wasn't provided.
   */
  callerSetPriority?: boolean;
  /** Skip the auto-run evaluation entirely (e.g. re-triage of old items). */
  skipAutoRun?: boolean;
}

interface TriageScore {
  /** 0–100; higher = more urgent. */
  urgency: number;
  /** 0 = high, 1 = medium, 2 = low — mirrors workItems.priorityTier. */
  tier: 0 | 1 | 2;
  /** An EXISTING project id this item clearly belongs to, else null. */
  projectId: string | null;
  /** Explicit deadline extracted from the text, epoch ms, else null. */
  dueAt: number | null;
}

// ---------------------------------------------------------------------------
// Deterministic fallback scoring
// ---------------------------------------------------------------------------

const HIGH_URGENCY_RE =
  /\b(urgent|asap|immediately|right away|today|tonight|this morning|this afternoon|before .*(flight|meeting|call|deadline)|deadline|overdue|expiring|expires?|by (eod|end of day|noon|tomorrow morning))\b/i;

const LOW_URGENCY_RE =
  /\b(someday|eventually|no rush|when (you|we) (get|have) (a chance|time)|low priority|nice to have|backlog|later this (month|quarter|year))\b/i;

/**
 * Sender/channel provenance line a channel-tagged producer writes into an
 * item's notes ("From: Aileen Diaz via whatsapp"). A message from a real
 * person waiting on the other end of a channel is more urgent than a
 * self-captured note, so the heuristic bumps urgency when it sees one.
 */
const SENDER_PROVENANCE_RE =
  /From: .+ via (slack|email|sms|whatsapp|telegram)/i;

/** Urgency points added when {@link SENDER_PROVENANCE_RE} matches the notes. */
const SENDER_PROVENANCE_URGENCY_BUMP = 15;

function heuristicScore(item: WorkItem): TriageScore {
  const text = `${item.title} ${item.notes ?? ""}`;
  const base = { projectId: null, dueAt: null };
  const score: TriageScore = HIGH_URGENCY_RE.test(text)
    ? { urgency: 85, tier: 0, ...base }
    : LOW_URGENCY_RE.test(text)
      ? { urgency: 25, tier: 2, ...base }
      : { urgency: 50, tier: 1, ...base };
  // A named human sender on a real channel is waiting — rank it above
  // same-tier self-notes (urgency feeds sortIndex; tier is left alone).
  if (item.notes && SENDER_PROVENANCE_RE.test(item.notes)) {
    score.urgency = Math.min(
      100,
      score.urgency + SENDER_PROVENANCE_URGENCY_BUMP,
    );
  }
  return score;
}

// ---------------------------------------------------------------------------
// Source-context stamping
// ---------------------------------------------------------------------------

/**
 * Build the `source_context` JSON snapshot stamped at triage time: the origin
 * (the capturing channel/surface — chat/voice/mcp/a channel name) plus a short
 * snippet of the original request text. The runner reads this to tell the
 * agent where a task came from. Returns a compact JSON string.
 */
export function buildSourceContext(item: WorkItem): string {
  const origin = item.sourceType ?? "chat";
  const snippetSource = item.notes?.trim() || item.title.trim();
  const snippet =
    snippetSource.length > 500
      ? `${snippetSource.slice(0, 500)}…`
      : snippetSource;
  return JSON.stringify({
    origin,
    ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    snippet,
    capturedAt: item.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Flash-LLM scoring (best-effort)
// ---------------------------------------------------------------------------

/** Exported for tests; production callers go through {@link triageWorkItem}. */
export function buildTriagePrompt(item: WorkItem, projects: Project[]): string {
  const source = item.sourceType ? ` (captured from ${item.sourceType})` : "";
  const projectLines = projects
    .slice(0, 20)
    .map((p) => `  - ${p.id}: ${p.title}`);
  return [
    `Today is ${new Date().toString()}.`,
    `Task${source}: ${item.title}`,
    // Notes are included verbatim (bounded) — channel-tagged producers write
    // sender provenance there ("From: <name> via <channel>"), which the
    // sender-identity instruction below tells the scorer how to weigh.
    item.notes ? `Details: ${item.notes.slice(0, 500)}` : "",
    // Provenance: the capturing channel/surface + its source id, when stamped.
    item.sourceType
      ? `Source: ${item.sourceType}${item.sourceId ? ` (source id: ${item.sourceId})` : ""}`
      : "",
    projectLines.length > 0
      ? `Existing projects:\n${projectLines.join("\n")}`
      : "",
    "",
    "Triage this task for a busy professional. Reply with ONLY a JSON object, no prose:",
    '{"urgency": <0-100>, "tier": <0|1|2>, "projectId": <string|null>, "dueAt": <"YYYY-MM-DDTHH:MM"|null>}.',
    "tier 0 = must happen soon (hard deadline, time-sensitive, blocking someone). tier 1 = normal. tier 2 = whenever.",
    'Sender identity: when the details carry a message from a real named person addressed to the user (e.g. a "From: <name> via <channel>" line, or a channel source like email/slack/whatsapp with a named sender), default to HIGHER urgency than a self-captured note — a person is waiting on a response. When the sender is clearly a VIP or frequent correspondent (boss, investor, client, close collaborator, an ongoing thread), boost the tier one level as well. Items with no sender are self-notes and score normally.',
    "projectId: the id of the ONE existing project this clearly belongs to, else null. Never invent an id.",
    'dueAt: only when the text states an explicit deadline ("by Friday", "before the flight tomorrow") — resolve it to a local date-time; else null. When only a day is given, use 17:00.',
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseTriageResponse(
  text: string,
  validProjectIds: ReadonlySet<string>,
  now = Date.now(),
): TriageScore | null {
  const match = text.match(/\{[^{}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      urgency?: unknown;
      tier?: unknown;
      projectId?: unknown;
      dueAt?: unknown;
    };
    const urgency = Number(parsed.urgency);
    const tier = Number(parsed.tier);
    if (!Number.isFinite(urgency) || !Number.isFinite(tier)) return null;
    const clampedTier = Math.min(2, Math.max(0, Math.round(tier))) as 0 | 1 | 2;
    // Hallucinated project ids are dropped — the scorer may only pick from
    // the ids it was shown, never mint one.
    const projectId =
      typeof parsed.projectId === "string" &&
      validProjectIds.has(parsed.projectId)
        ? parsed.projectId
        : null;
    // "YYYY-MM-DDTHH:MM" parses as local time; reject unparseable values and
    // anything more than a day in the past (a nonsense extraction).
    let dueAt: number | null = null;
    if (typeof parsed.dueAt === "string") {
      const t = Date.parse(parsed.dueAt);
      if (Number.isFinite(t) && t > now - 24 * 3600_000) dueAt = t;
    }
    return {
      urgency: Math.min(100, Math.max(0, Math.round(urgency))),
      tier: clampedTier,
      projectId,
      dueAt,
    };
  } catch {
    return null;
  }
}

async function scoreWithFlashLlm(
  item: WorkItem,
  projects: Project[],
): Promise<TriageScore | null> {
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) return null;
    const config = getConfig();
    const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
    const result = await runBtwSidechain({
      content: buildTriagePrompt(item, projects),
      provider,
      systemPrompt:
        "You are a triage scorer. Reply with ONLY the requested JSON object.",
      messages: [],
      tools: [],
      callSite: "conversationTitle",
      maxTokens: resolved.maxTokens,
      timeoutMs: TRIAGE_TIMEOUT_MS,
    });
    return parseTriageResponse(result.text, new Set(projects.map((p) => p.id)));
  } catch (err) {
    log.debug({ err: String(err) }, "flash triage failed; using heuristic");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Autonomy classification for auto-run
// ---------------------------------------------------------------------------

function parseRequiredTools(item: WorkItem): string[] {
  if (!item.requiredTools) return [];
  try {
    const parsed = JSON.parse(item.requiredTools) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * The autonomy classes an item touches. An empty tool snapshot classifies as
 * ["other"] — the run will still hit per-tool permission gates at execution
 * time, so "other" is the honest label for "we don't know yet".
 */
export function classifyWorkItemAutonomy(item: WorkItem): AutonomyClass[] {
  const tools = parseRequiredTools(item);
  if (tools.length === 0) return ["other"];
  const classes = new Set<AutonomyClass>();
  for (const tool of tools) classes.add(classifyAutonomy(tool));
  return [...classes];
}

// ---------------------------------------------------------------------------
// Hard-deny guard for auto-run
// ---------------------------------------------------------------------------

/**
 * Tool-name segments that indicate a purchase/ordering capability. Matched on
 * whole name segments (split on non-alphanumerics), not substrings, so
 * "recorder" or "sort_order_index" style names don't false-positive.
 */
const PURCHASE_SEGMENTS: ReadonlySet<string> = new Set([
  "purchase",
  "buy",
  "checkout",
  "order",
  "orders",
  "cart",
  "pay",
  "payment",
  "charge",
  "transfer",
  "refund",
]);

/**
 * Whether a single tool must never run under the auto-runner without a human
 * in the loop — REGARDLESS of what the per-category autonomy policy says.
 *
 * The autonomy policy is a preference; this is a floor. It exists because the
 * auto-runner once picked up a physical-world errand ("buy stroopwafels")
 * whose tool snapshot included browser tools and walked into an Amazon
 * purchase flow. Categories:
 *
 *   - `host_*`: desktop host control (host_bash, host_cu, host_browser,
 *     host_app_control, host_file) — executes on the user's machine.
 *   - browser / computer-use automation — can navigate arbitrary flows,
 *     including checkout pages, with no per-action review.
 *   - purchase/order-like tools — spend money directly.
 *   - messaging egress + money (via `classifyAutonomy`) — sends on the
 *     user's behalf / moves money.
 */
export function isHardDeniedForAutoRun(toolName: string): boolean {
  const name = toolName.toLowerCase();
  const segments = name.split(/[^a-z0-9]+/).filter(Boolean);

  // Desktop host control tools all share the host_ prefix.
  if (segments[0] === "host") return true;

  // Browser & computer-use automation (core browser_* tools, MCP
  // mcp__computer-use__*, connector *_browser_* variants, …).
  if (segments.includes("browser") || segments.includes("computer")) {
    return true;
  }

  // Purchase / order-like tools by name segment.
  if (segments.some((s) => PURCHASE_SEGMENTS.has(s))) return true;

  // Messaging egress ("send") and money per the shared autonomy classifier.
  const cls = classifyAutonomy(toolName);
  return cls === "send" || cls === "money";
}

/**
 * The subset of an item's required-tools snapshot that is hard-denied for
 * auto-run. Non-empty result ⇒ the item must wait for an explicit human
 * "Run it", no matter how permissive the autonomy policy snapshot is.
 */
export function hardDeniedAutoRunTools(item: WorkItem): string[] {
  return parseRequiredTools(item).filter(isHardDeniedForAutoRun);
}

// ---------------------------------------------------------------------------
// Conservative required-tools stamp for deterministic producers
// ---------------------------------------------------------------------------

/**
 * The read/research-only tool set deterministic producers (meeting/voice
 * action items, mission plan items) stamp onto the work items they create.
 *
 * Why: an item created with NO `requiredTools` snapshot classifies as
 * ["other"], which every sane policy fail-closes to "ask" — so those items
 * could never auto-run and parked forever. Stamping a snapshot that
 * classifies to a real autonomy category (these two are both "research")
 * lets the per-category policy actually decide.
 *
 * Safety: the runner auto-approves an item's requiredTools during its run,
 * so this set must ONLY ever contain read/research/draft-class tools. NEVER
 * add send/money/delete/publish/browser/computer-use/host_* tools here —
 * every entry must pass {@link isHardDeniedForAutoRun} (enforced again at
 * stamp time as a belt-and-suspenders filter). Note the set is also
 * deliberately narrow at run time: anything outside it still hits the
 * normal per-tool permission gates mid-run.
 */
export const CONSERVATIVE_AUTO_RUN_TOOLS: readonly string[] = [
  "web_fetch",
  "web_search",
];

/**
 * Keyword guard for side-effect deliverables. When an item's text clearly
 * implies egress or an irreversible action ("email X", "post Y", "buy Z",
 * "cancel W"), producers leave `requiredTools` EMPTY on purpose: the empty
 * snapshot classifies as "other" → policy "ask" → the item parks for human
 * review, which is the correct outcome there. Over-matching is safe (the
 * item just stays parked, exactly as before this guard existed);
 * under-matching only means the item auto-runs with read-only tools
 * approved — real egress still hits the per-tool permission gates mid-run.
 */
const SIDE_EFFECT_DELIVERABLE_RE =
  /\b(send|resend|forward|reply|respond|email|e-mail|message|text|dm|ping|post|publish|tweet|announce|share|submit|deploy|launch|release|ship|buy|purchase|order|pay|invoice|charge|refund|transfer|wire|book|reserve|subscribe|unsubscribe|sign\s*up|register|enroll|rsvp|invite|schedule|call|phone|dial|follow\s*up\s+with|cancel|delete|remove|archive|approve|reject|merge|upload|sell|donate)\b/i;

/** Whether the text clearly implies a side-effect deliverable. */
export function impliesSideEffectDeliverable(text: string): boolean {
  return SIDE_EFFECT_DELIVERABLE_RE.test(text);
}

/**
 * The `requiredTools` JSON snapshot a deterministic producer should stamp on
 * a work item it creates, or `undefined` to deliberately leave the snapshot
 * empty (side-effect-implying items park for review — see
 * {@link impliesSideEffectDeliverable}).
 */
export function conservativeRequiredToolsForCapture(
  title: string,
  notes?: string | null,
): string | undefined {
  if (impliesSideEffectDeliverable(`${title} ${notes ?? ""}`)) {
    return undefined;
  }
  const safe = CONSERVATIVE_AUTO_RUN_TOOLS.filter(
    (t) => !isHardDeniedForAutoRun(t),
  );
  return safe.length > 0 ? JSON.stringify(safe) : undefined;
}

function countRunningItems(): number {
  return listWorkItems({ status: "running" }).length;
}

function isAutoRunDisabled(): boolean {
  // Read at call time so the kill-switch works without a daemon restart when
  // the process env is updated by a supervisor.
  return getDisableWorkItemAutoRun();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Outcome of the triage + auto-run pass, for callers that want to report an
 * honest status back to the model/user (e.g. the `task_list_add` tool result
 * should say "running in the background" when the auto-runner actually
 * started the item, not "queued").
 */
export interface TriageAutoRunOutcome {
  /** True when the policy gate passed and the background run was started. */
  autoRunStarted: boolean;
  /**
   * Why the item did (or didn't) auto-run — one of the {@link AutoRunDecision}
   * reasons, or "skipped" when the caller opted out / triage crashed before
   * the decision was evaluated.
   */
  reason: AutoRunDecision["reason"] | "skipped";
}

/**
 * Triage the item, then auto-run it when policy allows. Never rejects — all
 * failures degrade to "item stays queued as-is" with `autoRunStarted: false`.
 *
 * Callable fire-and-forget (`void triageAndMaybeAutoRunWorkItem(id)`) from
 * capture paths that don't care about the outcome, or awaited by callers that
 * fold the auto-run decision into their own result (the enqueue tool).
 */
export function triageAndMaybeAutoRunWorkItem(
  workItemId: string,
  opts: TriageOptions = {},
): Promise<TriageAutoRunOutcome> {
  return (async (): Promise<TriageAutoRunOutcome> => {
    try {
      await triageWorkItem(workItemId, opts);
      if (!opts.skipAutoRun) {
        const decision = await maybeAutoRunWorkItem(workItemId);
        return { autoRunStarted: decision.started, reason: decision.reason };
      }
      return { autoRunStarted: false, reason: "skipped" };
    } catch (err) {
      log.warn({ workItemId, err: String(err) }, "work-item triage failed");
      return { autoRunStarted: false, reason: "skipped" };
    }
  })();
}

/** Statuses in which triage has nothing useful left to contribute. */
const TRIAGE_SKIP_STATUSES: readonly string[] = ["archived", "cancelled"];

/** Exported for tests; production callers go through {@link triageAndMaybeAutoRunWorkItem}. */
export async function triageWorkItem(
  workItemId: string,
  opts: TriageOptions,
): Promise<void> {
  const item = getWorkItem(workItemId);
  if (!item || TRIAGE_SKIP_STATUSES.includes(item.status)) return;

  const projects = listProjects();
  const score =
    (await scoreWithFlashLlm(item, projects)) ?? heuristicScore(item);

  const updates: {
    priorityTier?: number;
    sortIndex?: number;
    projectId?: string;
    dueAt?: number;
    sourceContext?: string;
  } = {};
  if (!opts.callerSetPriority) updates.priorityTier = score.tier;
  // Stamp where this task came from — the creating channel/origin plus a
  // snippet of the original text — so the runner can tell the agent the
  // provenance ("this came from a WhatsApp thread") when it works the task.
  // Only fill when blank; a caller may have supplied richer source context.
  if (item.sourceContext == null) {
    updates.sourceContext = buildSourceContext(item);
  }
  // Higher urgency → smaller sortIndex → sorts first within its tier.
  if (item.sortIndex == null) updates.sortIndex = 100 - score.urgency;
  // Never overwrite a human/caller assignment — triage only fills blanks.
  if (item.projectId == null && score.projectId) {
    updates.projectId = score.projectId;
  }
  if (item.dueAt == null && score.dueAt) updates.dueAt = score.dueAt;

  // Re-check state right before writing — the item may have started running
  // or been edited while the LLM call was in flight. Priority re-scoring only
  // applies while the item is still queued (a run or user edit owns it after
  // that), but the blank-fill fields (sortIndex/dueAt/projectId) are stamped
  // regardless: they only ever fill holes, and skipping them entirely used to
  // leave fast-raced items with no dueAt/sortIndex at all even when the notes
  // said "by Friday 5pm".
  const fresh = getWorkItem(workItemId);
  if (!fresh) return;
  if (fresh.status !== "queued") delete updates.priorityTier;
  if (fresh.sortIndex != null) delete updates.sortIndex;
  if (fresh.projectId != null) delete updates.projectId;
  if (fresh.dueAt != null) delete updates.dueAt;
  if (fresh.sourceContext != null) delete updates.sourceContext;

  if (Object.keys(updates).length === 0) return;
  updateWorkItem(workItemId, updates, { actor: "triage" });
  log.info(
    { workItemId, urgency: score.urgency, tier: score.tier, ...opts },
    "work item triaged",
  );
  broadcastWorkItemStatus(workItemId);
}

/**
 * The auto-run gate's verdict: whether the background run was started, and
 * the deterministic reason when it wasn't.
 */
export interface AutoRunDecision {
  started: boolean;
  reason:
    | "started"
    | "disabled"
    | "not_queued"
    | "user_parked"
    | "hard_denied"
    | "policy_ask"
    | "concurrency_cap"
    | "run_failed";
}

/** Exported for tests; production callers go through {@link triageAndMaybeAutoRunWorkItem}. */
export async function maybeAutoRunWorkItem(
  workItemId: string,
): Promise<AutoRunDecision> {
  if (isAutoRunDisabled()) return { started: false, reason: "disabled" };

  const item = getWorkItem(workItemId);
  if (!item || item.status !== "queued") {
    return { started: false, reason: "not_queued" };
  }

  // User-parked items never auto-run, no matter what the autonomy policy
  // says. A quick-added project task, a plain voice to-do, or a needs-you
  // feed item is a note the user filed — not triage-approved ready work —
  // and the ONLY thing that may start it is an explicit run (the Run
  // button / came-in confirm / CLI), which clears the marker at dispatch.
  // Evaluated before every other gate so neither capture-time triage nor
  // the periodic queue drainer can re-dispatch a parked item.
  if (item.autoRunEligibility === "parked") {
    return { started: false, reason: "user_parked" };
  }

  // Safety floor, evaluated BEFORE the policy: items whose tool snapshot
  // includes host control, browser/computer-use automation, purchase/order
  // tools, or messaging/money egress never auto-run — even if the user's
  // autonomy policy marks every category "auto". They stay queued for an
  // explicit human "Run it".
  const hardDenied = hardDeniedAutoRunTools(item);
  if (hardDenied.length > 0) {
    log.info(
      { workItemId, hardDenied },
      "auto-run hard-denied: required tools need a human in the loop (item stays queued)",
    );
    return { started: false, reason: "hard_denied" };
  }

  const policy = await getAutonomyPolicy();
  const classes = classifyWorkItemAutonomy(item);
  const blocked = classes.filter((c) => policy[c] !== "auto");
  if (blocked.length > 0) {
    // The per-category policy would park this item. Consult the owner's
    // standing "Make it a rule" decisions: a rule scoped to this item's sender
    // or channel (or its exact blocked category/tool) clears the deferral. The
    // hard-deny floor above already ran, so a rule can never push a
    // host/browser/purchase/send/money item into an unattended run — it only
    // loosens the softer per-category "ask".
    const authorizingRule = findAuthorizingStandingRule({
      channel: item.sourceType,
      sourceId: item.sourceId,
      provenanceText: `${item.notes ?? ""}\n${item.sourceContext ?? ""}`,
      classes,
      tools: parseRequiredTools(item),
      blockedClasses: blocked,
    });
    if (!authorizingRule) {
      log.debug(
        { workItemId, classes, blocked },
        "auto-run deferred: policy asks for these categories",
      );
      return { started: false, reason: "policy_ask" };
    }
    log.info(
      {
        workItemId,
        ruleId: authorizingRule.id,
        triggerType: authorizingRule.triggerType,
        triggerValue: authorizingRule.triggerValue,
        blocked,
      },
      "auto-run authorized by standing rule (policy_ask cleared)",
    );
  }

  const running = countRunningItems();
  if (running >= MAX_AUTO_CONCURRENT_RUNS) {
    log.info(
      { workItemId, running },
      "auto-run deferred: concurrency cap reached (item stays queued)",
    );
    return { started: false, reason: "concurrency_cap" };
  }

  const result = runWorkItemInBackground(workItemId);
  log.info(
    { workItemId, classes, success: result.success, error: result.error },
    "work item auto-run per autonomy policy",
  );
  return result.success
    ? { started: true, reason: "started" }
    : { started: false, reason: "run_failed" };
}
