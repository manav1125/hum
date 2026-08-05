/**
 * Advisor escalation (WS-B): before the main brain commits a high-stakes or
 * uncertain action, consult a STRONGER model for a second opinion and feed the
 * critique back into the loop before the proposed tool actually runs.
 *
 * Relationship to flash-/vision-tier (`agent/flash-tier.ts`,
 * `agent/vision-tier.ts`): those two SWAP the model for the round's single
 * inference call (a routing decision — same call, different model id). The
 * advisor is different in kind: it is a SEPARATE, additional inference call to
 * a different model, made mid-loop, whose output is injected back as guidance.
 * What it shares with them is the shape of the pure decision surface — a
 * structural gate plus a model resolver, both side-effect-free and unit-tested
 * the same way — and the routing mechanism for the consult call itself (a
 * per-call `config.model` override that wins over call-site resolution in
 * `RetryProvider.normalizeSendMessageOptions`, and therefore over the self-host
 * FORCE_OPENROUTER env pin).
 *
 * Design constraints:
 *
 * - **Selective, never every turn.** The gate fires only on a TOOL-BEARING
 *   round (the loop invokes it at the pre-execution seam) that additionally
 *   carries a high-stakes signal: a destructive/irreversible tool is about to
 *   run, or the assistant's own text expresses explicit uncertainty (a
 *   low-confidence proxy — the provider exposes no numeric confidence). A
 *   plain, confident, low-risk tool round is left untouched.
 *
 *   "High-stakes" is the MAX of two risk views: the tool's static
 *   `defaultRiskLevel === "high"` (statically-destructive tools like a2a_send
 *   or credential writes), OR the PROPOSED call's per-command classified risk
 *   being `high`. The latter is what catches bash: its static risk is only
 *   Medium because a shell command's real risk is judged per-command by the
 *   gateway's classifier at execution time (`rm -rf …` is high, `ls` is low),
 *   not by static tool metadata. The caller classifies the proposed command at
 *   the gate (fail-open) and threads the result in via
 *   `ProposedToolUse.classifiedRisk`; without it, bash's Medium static risk
 *   would never trip the destructive signal — the single most common way to do
 *   destructive things.
 * - **Cost-bounded.** At most `llm.advisor.maxConsultsPerTurn` consults per
 *   user turn, and — by construction — never twice for the same round: the
 *   loop invokes the gate once per iteration and passes `alreadyConsulted`
 *   once the per-turn budget is spent.
 * - **Fail-open.** A consult that errors, times out, or returns empty text
 *   resolves to `null`; the loop then executes the proposed tools exactly as it
 *   would have without the advisor. The advisor can only ADD a reconsideration
 *   round, never break or block a turn.
 * - **Transport is not re-routed.** Same rule as flash/vision-tier: only the
 *   model id changes on the consult call; it runs on the mainAgent provider, so
 *   the advisor model must be servable there. The consult carries NO tools (it
 *   critiques, it does not act) and a fresh advisor system prompt.
 */

import type { AdvisorConfig, LLMConfig } from "../config/schemas/llm.js";
import { RiskLevel } from "../permissions/types.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { renderAdvisorEnvironmentBlock } from "../subagent/consult-context.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("advisor");

/** Locked defaults (see docs/prealpha-adoption-program.md lock decision #2). */
export const DEFAULT_ADVISOR_MODEL = "moonshotai/kimi-k3";
export const DEFAULT_ADVISOR_FALLBACK_MODEL = "z-ai/glm-5.2";

/** The structural signal that decided a consult (for logs/evals). */
export type AdvisorSignal = "destructive_tool" | "explicit_uncertainty";

export interface AdvisorGateDecision {
  consult: boolean;
  /**
   * The signal that fired (`consult === true`), or why the gate declined
   * (`consult === false`).
   */
  reason:
    | AdvisorSignal
    | "no_tool_use"
    | "no_signal"
    | "budget_exhausted"
    | "disabled";
}

export interface ProposedToolUse {
  name: string;
  /**
   * The proposed call's per-command classified risk, when the caller ran the
   * gateway classifier for this specific invocation (bash/shell, whose real
   * risk is per-command, not static). Folded into the high-stakes signal as
   * `max(staticDefaultRisk, classifiedRisk) === high`. Absent for tools the
   * caller did not classify — the gate then relies on static risk alone.
   */
  classifiedRisk?: RiskLevel;
}

/**
 * Whether a single proposed call is high-stakes: its tool is statically
 * destructive (`isHighStakesTool`), OR its per-command classified risk is
 * `high`. This is the `max(staticDefaultRisk, perCommandClassifiedRisk) ===
 * high` condition that lets bash's per-command `rm -rf …` trip the gate even
 * though bash's static `defaultRiskLevel` is only Medium.
 */
function isCallHighStakes(
  toolUse: ProposedToolUse,
  isHighStakesTool: (toolName: string) => boolean,
): boolean {
  if (isHighStakesTool(toolUse.name)) return true;
  return toolUse.classifiedRisk === RiskLevel.High;
}

/**
 * Purely structural gate. No I/O, no LLM call — safe to run on every round.
 *
 * Precedence: a destructive tool outranks uncertainty (higher stakes). The
 * budget check is first so an exhausted turn short-circuits before any signal
 * scan.
 */
export function classifyRoundForAdvisor(opts: {
  advisor: AdvisorConfig;
  /** The tool_use blocks the model proposed for this round. */
  proposedToolUses: ProposedToolUse[];
  /** The assistant's own text for the round (uncertainty scan). */
  assistantText: string;
  /**
   * True when the tool is STATICALLY high-stakes/destructive — the caller
   * derives this from tool metadata (`defaultRiskLevel === "high"`). Per-command
   * risk (bash) is carried separately on `ProposedToolUse.classifiedRisk` and
   * folded in via `max(static, perCommand)`.
   */
  isHighStakesTool: (toolName: string) => boolean;
  /** True once the per-turn consult budget is spent. */
  alreadyConsulted: boolean;
}): AdvisorGateDecision {
  const { advisor, proposedToolUses, assistantText, alreadyConsulted } = opts;

  if (!advisor.enabled) return { consult: false, reason: "disabled" };
  // The loop only consults before committing an action; a no-tool round has
  // nothing to hold, so it is never a gate point.
  if (proposedToolUses.length === 0) {
    return { consult: false, reason: "no_tool_use" };
  }
  if (alreadyConsulted) return { consult: false, reason: "budget_exhausted" };

  if (advisor.consultOnDestructiveTools) {
    for (const toolUse of proposedToolUses) {
      if (isCallHighStakes(toolUse, opts.isHighStakesTool)) {
        return { consult: true, reason: "destructive_tool" };
      }
    }
  }

  if (
    advisor.consultOnUncertainty &&
    textCarriesUncertainty(assistantText, advisor)
  ) {
    return { consult: true, reason: "explicit_uncertainty" };
  }

  return { consult: false, reason: "no_signal" };
}

/**
 * Whether `text` contains any configured uncertainty marker (case-insensitive
 * substring match). A structural low-confidence proxy — the provider gives us
 * no numeric confidence, so hedging language is the best available signal.
 */
export function textCarriesUncertainty(
  text: string,
  advisor: AdvisorConfig,
): boolean {
  if (text.length === 0) return false;
  const haystack = text.toLowerCase();
  return advisor.uncertaintyMarkers.some((marker) => haystack.includes(marker));
}

export interface AdvisorModelResolution {
  model: string;
  /** Distinct from `model`, else omitted (no usable fallback). */
  fallbackModel?: string;
}

/**
 * Resolve the advisor model (and optional fallback), or `undefined` when the
 * advisor is disabled.
 *
 * Source order for the primary model:
 *   1. `CUE_ADVISOR_MODEL` env (self-host operator override)
 *   2. `llm.advisor.model` (config)
 *   3. `DEFAULT_ADVISOR_MODEL` (kimi-k3)
 *
 * Fallback: `CUE_ADVISOR_FALLBACK_MODEL` env → `llm.advisor.fallbackModel` →
 * `DEFAULT_ADVISOR_FALLBACK_MODEL` (glm-5.2). A fallback equal to the primary
 * is dropped (it would be a no-op retry on the same model).
 */
export function resolveAdvisorModel(
  llm: LLMConfig,
  env: Record<string, string | undefined> = process.env,
): AdvisorModelResolution | undefined {
  const advisor = llm.advisor;
  if (!advisor.enabled) return undefined;

  const model =
    nonEmpty(env.CUE_ADVISOR_MODEL) ?? advisor.model ?? DEFAULT_ADVISOR_MODEL;

  const fallbackModel =
    nonEmpty(env.CUE_ADVISOR_FALLBACK_MODEL) ??
    advisor.fallbackModel ??
    DEFAULT_ADVISOR_FALLBACK_MODEL;

  return fallbackModel && fallbackModel !== model
    ? { model, fallbackModel }
    : { model };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface AdvisorRoute {
  model: string;
  fallbackModel?: string;
  reason: AdvisorSignal;
}

/**
 * Full per-round gate: config flag → structural signal → resolved advisor
 * model. Returns the route to consult, or `null` to skip the consult and
 * proceed with the proposed action unchanged.
 */
export function resolveAdvisorRouteForRound(opts: {
  llm: LLMConfig;
  proposedToolUses: ProposedToolUse[];
  assistantText: string;
  isHighStakesTool: (toolName: string) => boolean;
  alreadyConsulted: boolean;
  env?: Record<string, string | undefined>;
}): AdvisorRoute | null {
  const { llm } = opts;
  if (!llm.advisor.enabled) return null;

  const decision = classifyRoundForAdvisor({
    advisor: llm.advisor,
    proposedToolUses: opts.proposedToolUses,
    assistantText: opts.assistantText,
    isHighStakesTool: opts.isHighStakesTool,
    alreadyConsulted: opts.alreadyConsulted,
  });
  if (!decision.consult) return null;

  const resolved = resolveAdvisorModel(llm, opts.env);
  if (resolved == null) return null;

  return {
    model: resolved.model,
    ...(resolved.fallbackModel
      ? { fallbackModel: resolved.fallbackModel }
      : {}),
    reason: decision.reason as AdvisorSignal,
  };
}

// ── Consult prompt construction (pure) ──────────────────────────────────────

const ADVISOR_SYSTEM_PROMPT = `You are a senior technical advisor consulted mid-task by another AI agent that is about to take an action. You are STRONGER and more careful than the agent that called you.

The agent has proposed one or more tool calls. Before it commits them, give it a short, decisive second opinion. Focus on:
- Is this action correct and safe given the conversation so far?
- For destructive or irreversible actions: is the target right, is it what the user actually asked for, and is there a safer alternative?
- If the agent expressed uncertainty, resolve it: state the right course of action plainly.

Respond in 2-6 sentences. Lead with a clear verdict — PROCEED, PROCEED WITH CHANGES, or DO NOT PROCEED — then the reason and, if changes are needed, exactly what to do instead. Do not restate the plan back. Do not call any tools; you are advising, not acting.`;

/** A compact, wire-safe rendering of a proposed tool call for the consult. */
function summarizeToolUse(block: ContentBlock): string | null {
  if (block.type !== "tool_use") return null;
  let inputStr: string;
  try {
    inputStr = JSON.stringify(block.input);
  } catch {
    inputStr = "[unserializable input]";
  }
  // Bound the input so a huge payload can't blow the consult context.
  if (inputStr.length > 2000)
    inputStr = `${inputStr.slice(0, 2000)}… [truncated]`;
  return `- ${block.name}(${inputStr})`;
}

function assistantTextOf(content: readonly ContentBlock[]): string {
  return content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Build the consult messages: the advisor system prompt plus a single user
 * message that carries the proposed action and the reason it was escalated.
 * Deliberately does NOT include the dangling assistant tool_use message —
 * appending a user turn after an unanswered tool_use would violate the
 * tool_use/tool_result invariant on the consult call. The prior history (up to
 * but not including this round's assistant message) supplies the context.
 *
 * `situationalContext` is the runtime context pack from `buildAdvisorContext`
 * (`subagent/consult-context.ts`): the agent's live tool set, the skill
 * catalog it can load, its workspace, and trust-gated personal memory. It
 * rides in this request turn rather than the system prompt so the system
 * prompt stays minimal, and it is fenced as untrusted data because it embeds
 * externally authored text.
 */
export function buildAdvisorConsultMessages(opts: {
  proposedContent: readonly ContentBlock[];
  reason: AdvisorSignal;
  situationalContext?: string | null;
}): { systemPrompt: string; userMessage: Message } {
  const { proposedContent, reason, situationalContext } = opts;
  const proposedText = assistantTextOf(proposedContent);
  const toolLines = proposedContent
    .map(summarizeToolUse)
    .filter((l): l is string => l != null);

  const reasonLine =
    reason === "destructive_tool"
      ? "This round proposes a high-stakes or irreversible tool call."
      : "The agent expressed uncertainty while proposing this action.";

  const parts: string[] = [
    "<advisor_consult>",
    reasonLine,
    "",
    "The agent's reasoning for this round:",
    proposedText.length > 0 ? proposedText : "(no reasoning text)",
    "",
    "Proposed tool call(s):",
    toolLines.length > 0 ? toolLines.join("\n") : "(none)",
    "",
    ...(situationalContext
      ? [renderAdvisorEnvironmentBlock(situationalContext), ""]
      : []),
    "Give your second opinion now.",
    "</advisor_consult>",
  ];

  return {
    systemPrompt: ADVISOR_SYSTEM_PROMPT,
    userMessage: {
      role: "user",
      content: [{ type: "text", text: parts.join("\n") }],
    },
  };
}

/**
 * Render the advice for injection back into the main loop. The main brain sees
 * this as the tool_result for each held tool_use, so it reads as guidance to
 * reconsider BEFORE re-issuing (or revising) the action.
 */
export function formatAdvisorGuidance(advice: AdvisorAdvice): string {
  return [
    "<advisor_guidance>",
    `A stronger advisor model (${advice.model}) reviewed the action you were about to take and returned this second opinion:`,
    "",
    advice.critique,
    "",
    "Reconsider in light of this. If you still believe the action is correct, proceed by re-issuing it; otherwise revise or take the safer course the advisor described. Do not consult again for this same step.",
    "</advisor_guidance>",
  ].join("\n");
}

// ── The consult call (impure; provider injected for testability) ─────────────

export interface AdvisorAdvice {
  critique: string;
  /** The model that actually produced the advice (primary or fallback). */
  model: string;
}

/**
 * A progress-aware deadline for the consult. A reasoning advisor spends most of
 * its window thinking, so a fixed wall-clock cut would clip it mid-thought;
 * this aborts only after `idleMs` of genuine silence (no streamed token), with
 * an absolute `maxMs` backstop against a runaway/looping stream.
 */
function createConsultDeadline(opts: { idleMs: number; maxMs: number }): {
  signal: AbortSignal;
  recordProgress: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const recordProgress = (): void => {
    if (controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), opts.idleMs);
  };
  const maxTimer = setTimeout(() => controller.abort(), opts.maxMs);
  recordProgress(); // arm the idle window immediately (bounds time-to-first-token)

  return {
    signal: controller.signal,
    recordProgress,
    dispose: (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    },
  };
}

/**
 * A minimal provider surface — just `sendMessage` — so the consult can be
 * unit-tested with a mock and does not couple to the concrete `Provider`.
 */
export type AdvisorSend = (
  history: Message[],
  options: SendMessageOptions,
) => Promise<ProviderResponse>;

/**
 * Run the advisor consult, trying the primary model then the fallback. Returns
 * the advice, or `null` on total failure / empty output (the caller then
 * proceeds with the un-advised action — fail-open).
 *
 * The consult carries no tools and a fresh advisor system prompt; the model id
 * is pinned per-call so it runs on the mainAgent transport but the advisor
 * model.
 */
export async function consultAdvisor(opts: {
  send: AdvisorSend;
  /** History up to but NOT including this round's assistant message. */
  priorHistory: Message[];
  /** The assistant content the model proposed for this round. */
  proposedContent: readonly ContentBlock[];
  route: AdvisorRoute;
  advisor: AdvisorConfig;
  /**
   * Situational context pack from `buildAdvisorContext`
   * (`subagent/consult-context.ts`); rides in the consult request turn.
   */
  situationalContext?: string | null;
  selectionSeed?: string;
  signal?: AbortSignal;
}): Promise<AdvisorAdvice | null> {
  const { systemPrompt, userMessage } = buildAdvisorConsultMessages({
    proposedContent: opts.proposedContent,
    reason: opts.route.reason,
    situationalContext: opts.situationalContext,
  });
  const consultHistory = [...opts.priorHistory, userMessage];

  const models = opts.route.fallbackModel
    ? [opts.route.model, opts.route.fallbackModel]
    : [opts.route.model];

  for (const model of models) {
    const deadline = createConsultDeadline({
      idleMs: opts.advisor.idleTimeoutMs,
      maxMs: opts.advisor.maxTimeoutMs,
    });
    // Combine the consult deadline with the caller's own abort signal so a
    // user cancellation of the turn also tears the consult down.
    const signal =
      opts.signal != null
        ? AbortSignal.any([opts.signal, deadline.signal])
        : deadline.signal;
    try {
      const response = await opts.send(consultHistory, {
        systemPrompt,
        config: {
          model,
          callSite: "advisor",
          ...(opts.selectionSeed != null
            ? { selectionSeed: opts.selectionSeed }
            : {}),
        },
        signal,
        onEvent: () => deadline.recordProgress(),
      });
      const critique = assistantTextOf(response.content);
      if (critique.length > 0) {
        return { critique, model };
      }
      log.warn(
        { model },
        "advisor returned empty critique — trying fallback / failing open",
      );
    } catch (err) {
      log.warn(
        { err, model },
        "advisor consult failed — trying fallback / failing open",
      );
    } finally {
      deadline.dispose();
    }
  }
  return null;
}
