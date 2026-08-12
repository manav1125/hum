import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import { isToolAllowedInChannel } from "../channels/permission-profiles.js";
import type { ChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import {
  getCanonicalGuardianRequest,
  updateCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import {
  isUnparseableToolArgs,
  unparseableToolArgsMessage,
} from "../providers/unparseable-tool-args.js";
import { isUntrustedTrustClass } from "../runtime/actor-trust-resolver.js";
import { createOrReuseToolGrantRequest } from "../runtime/tool-grant-request-helper.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { getLogger } from "../util/logger.js";
import { safeTimeoutMs } from "./execution-timeout.js";
import { requiresHumanApprovalForAction } from "./outbound-send.js";
import { getAllTools, getTool, getToolOwner } from "./registry.js";
import { isSideEffectTool } from "./side-effects.js";
import { parseToolInput } from "./tool-input-schemas.js";
import { summarizeToolInput } from "./tool-input-summary.js";
import { suggestToolName } from "./tool-name-aliases.js";
import {
  type ExecutionTarget,
  isDiskPressureCleanupToolName,
  type Tool,
  type ToolContext,
  type ToolExecutionResult,
  type ToolLifecycleEvent,
} from "./types.js";
import { enforceVerificationControlPlanePolicy } from "./verification-control-plane-policy.js";

const log = getLogger("tool-approval-handler");

function buildToolGrantQuestionText(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): string {
  const senderLabel =
    context.requesterDisplayName ||
    context.requesterIdentifier ||
    context.requesterExternalUserId ||
    "A trusted contact";
  const inputSummary = redactSecrets(summarizeToolInput(toolName, input));
  return inputSummary
    ? `${senderLabel} wants to use "${toolName}": ${inputSummary}`
    : `${senderLabel} is requesting permission to use "${toolName}"`;
}

/** Default polling interval for inline grant wait (ms). */
const TC_GRANT_WAIT_INTERVAL_MS = 500;
/**
 * Fallback maximum wait for the inline grant wait (ms), used only when the
 * deployed config cannot be read. The governing budget is
 * `timeouts.permissionTimeoutSec` (see {@link resolveInlineGrantWaitMs}).
 */
export const TC_GRANT_WAIT_MAX_MS = 60_000;

/**
 * Resolve the wait budget for an escalated tool grant.
 *
 * A guardian answering an escalated tool call is making the same decision as a
 * local user answering a permission prompt, so both paths spend the same
 * budget: `timeouts.permissionTimeoutSec` (read by `permissions/prompter.ts`).
 * If anything, this path needs the larger share of it: the prompter's user
 * already has the prompt on screen, while the guardian is notified
 * out-of-band and has to context-switch before deciding.
 *
 * Falls back to {@link TC_GRANT_WAIT_MAX_MS} rather than the tool-execution
 * default on a non-positive value, so a bad config can never collapse the
 * window to zero and auto-deny every escalation. Timing out remains a DENY
 * (fail-closed); only the length of the window is configurable.
 *
 * Exported because the grant resolver sizes its `inline_wait_active` staleness
 * threshold off this same budget: if the two drift, an approval arriving while
 * a waiter is still live gets misread as a dead waiter and the requester is
 * told to retry a call that is about to resume on its own.
 */
export function resolveInlineGrantWaitMs(): number {
  return safeTimeoutMs(
    getConfig().timeouts.permissionTimeoutSec,
    TC_GRANT_WAIT_MAX_MS,
  );
}

/**
 * Inline wait result for trusted-contact grant polling.
 * - `granted`: a grant was minted and consumed within the wait window.
 * - `denied`: the guardian explicitly rejected the request.
 * - `timeout`: the wait budget expired without a decision.
 * - `aborted`: the session was cancelled during the wait.
 * - `escalation_failed`: the grant request could not be created.
 */
export type InlineGrantWaitOutcome =
  | { outcome: "granted"; grant: { id: string } }
  | { outcome: "denied"; requestId: string }
  | { outcome: "timeout"; requestId: string }
  | { outcome: "aborted" }
  | { outcome: "escalation_failed"; reason: string };

/**
 * Wait bounded for a guardian to approve a tool grant request and for the
 * resulting grant to become consumable. Polls both the canonical request
 * status (to detect early rejection) and the grant store (to detect approval
 * and atomically consume the grant).
 *
 * Only called for trusted_contact actors with valid guardian bindings.
 *
 * `options.maxWaitMs` overrides the wait budget; omitting it spends the
 * configured one from {@link resolveInlineGrantWaitMs}.
 */
export async function waitForInlineGrant(
  escalationRequestId: string,
  consumeParams: Parameters<typeof consumeGrantForInvocation>[0],
  options?: { maxWaitMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<InlineGrantWaitOutcome> {
  const maxWait = options?.maxWaitMs ?? resolveInlineGrantWaitMs();
  const interval = options?.intervalMs ?? TC_GRANT_WAIT_INTERVAL_MS;
  const signal = options?.signal;
  const deadline = Date.now() + maxWait;

  log.info(
    {
      event: "tc_inline_grant_wait_start",
      escalationRequestId,
      toolName: consumeParams.toolName,
      maxWaitMs: maxWait,
      intervalMs: interval,
    },
    "Starting inline wait for guardian grant decision",
  );

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { outcome: "aborted" };
    }

    await new Promise((resolve) => setTimeout(resolve, interval));

    if (signal?.aborted) {
      return { outcome: "aborted" };
    }

    // Check if the canonical request was rejected - exit early without
    // waiting for the full timeout.
    const request = getCanonicalGuardianRequest(escalationRequestId);
    if (request && request.status === "denied") {
      log.info(
        {
          event: "tc_inline_grant_wait_denied",
          escalationRequestId,
          toolName: consumeParams.toolName,
          elapsedMs: maxWait - (deadline - Date.now()),
        },
        "Guardian denied tool grant request during inline wait",
      );
      return { outcome: "denied", requestId: escalationRequestId };
    }

    // Try to consume the grant - if the guardian approved, the canonical
    // decision primitive will have minted a scoped grant by now.
    const grantResult = await consumeGrantForInvocation(consumeParams, {
      maxWaitMs: 0,
    });
    if (grantResult.ok) {
      log.info(
        {
          event: "tc_inline_grant_wait_granted",
          escalationRequestId,
          toolName: consumeParams.toolName,
          grantId: grantResult.grant.id,
          elapsedMs: maxWait - (deadline - Date.now()),
        },
        "Grant found during inline wait - tool execution proceeding",
      );
      return { outcome: "granted", grant: { id: grantResult.grant.id } };
    }
  }

  log.info(
    {
      event: "tc_inline_grant_wait_timeout",
      escalationRequestId,
      toolName: consumeParams.toolName,
      maxWaitMs: maxWait,
    },
    "Inline grant wait timed out - no guardian decision within budget",
  );
  return { outcome: "timeout", requestId: escalationRequestId };
}

const UI_SURFACE_TOOLS = new Set(["ui_show", "ui_update", "ui_dismiss"]);

function requiresGuardianApprovalForActor(
  toolName: string,
  input: Record<string, unknown>,
  executionTarget: ExecutionTarget,
): boolean {
  // UI surface tools are passive, user-visible operations (cards, forms,
  // tables). User input is voluntary and user-controlled — skip the guardian
  // gate so they work during fresh onboarding before trust is established.
  if (UI_SURFACE_TOOLS.has(toolName)) {
    return false;
  }

  // Side-effect tools always require guardian approval for untrusted actors.
  // Read-only host execution is also blocked because it can leak sensitive
  // local information (e.g. shell/file reads).
  return isSideEffectTool(toolName, input) || executionTarget === "host";
}

function guardianApprovalDeniedMessage(
  trustClass: ToolContext["trustClass"],
  toolName: string,
): string {
  if (trustClass === "unknown") {
    return `Permission denied for "${toolName}": this action requires guardian approval from a verified channel identity.`;
  }
  return `Permission denied for "${toolName}": this action requires guardian approval and the current actor is not the guardian.`;
}

export type PreExecutionGateResult =
  | {
      allowed: true;
      tool: Tool;
      grantConsumed?: boolean;
      /**
       * Input parsed against the tool's registered schema in
       * `TOOL_INPUT_SCHEMAS` (with `.catch()` recoveries applied). Set only
       * for built-in tools with a registered schema; the executor substitutes
       * it for the raw input so validation and execution see the same value.
       */
      parsedInput?: Record<string, unknown>;
    }
  | { allowed: false; result: ToolExecutionResult };

/**
 * Overrides for the inline grant wait behavior. Production leaves this empty
 * so the wait spends the configured budget; tests inject short waits to keep
 * escalation cases fast.
 */
export interface InlineGrantWaitConfig {
  /**
   * Maximum time to wait for guardian approval (ms). Defaults to the budget
   * from {@link resolveInlineGrantWaitMs}.
   */
  maxWaitMs?: number;
  /** Polling interval during the wait (ms). Defaults to TC_GRANT_WAIT_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * Handles pre-execution approval gates: abort checks, guardian policy,
 * allowed-tool-set gating, and task-run preflight checks.
 * These run before the interactive permission prompt flow.
 */
export class ToolApprovalHandler {
  private inlineGrantWaitConfig: InlineGrantWaitConfig;

  constructor(config?: { inlineGrantWait?: InlineGrantWaitConfig }) {
    this.inlineGrantWaitConfig = config?.inlineGrantWait ?? {};
  }

  /**
   * Evaluate all pre-execution approval gates for a tool invocation.
   * Returns the resolved Tool if all gates pass, or an early-return
   * ToolExecutionResult if any gate blocks execution.
   */
  async checkPreExecutionGates(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    executionTarget: ExecutionTarget,
    riskLevel: string,
    startTime: number,
    emitLifecycleEvent: (event: ToolLifecycleEvent) => void,
  ): Promise<PreExecutionGateResult> {
    // Bail out immediately if the session was aborted before this tool started.
    if (context.signal?.aborted) {
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: "Cancelled",
        isExpected: true,
        errorCategory: "tool_failure",
      });
      return {
        allowed: false,
        result: { content: "Cancelled", isError: true },
      };
    }

    // Reject tool calls whose arguments failed JSON parsing in the provider
    // layer (wrapped under the `_raw` marker). Executing with the marker
    // object would feed garbage input to the tool — and worse, a tool that
    // tolerates missing fields can "succeed" (e.g. ui_show creating a
    // typeless surface), so the model never learns its arguments were
    // mangled. Fail loudly instead so the model retries.
    if (isUnparseableToolArgs(input)) {
      const msg = unparseableToolArgsMessage(name, input._raw);
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: "tool_failure",
      });
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Reject tool invocations targeting guardian control-plane endpoints from non-guardian actors.
    const guardianCheck = enforceVerificationControlPlanePolicy(
      name,
      input,
      context.trustClass,
    );
    if (guardianCheck.denied) {
      log.warn(
        {
          toolName: name,
          conversationId: context.conversationId,
          trustClass: context.trustClass,
          reason: "guardian_only_policy",
        },
        "Guardian-only policy blocked tool invocation",
      );
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "permission_denied",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "deny",
        reason: guardianCheck.reason!,
        durationMs,
      });
      return {
        allowed: false,
        result: { content: guardianCheck.reason!, isError: true },
      };
    }

    // ── High-consequence action hard checkpoint ────────────────────────────
    // Any action that reaches outside or is irreversible — sending a message to
    // a third party, placing a call, moving money, making a purchase,
    // publishing/deploying, or deleting a record — ALWAYS requires explicit
    // human approval and can NEVER be cleared by internal/background "guardian"
    // trust. This runs for every actor (including guardian) and BEFORE both the
    // trust-scoped guardian gate below and the PermissionChecker — so it is
    // immune to guardian-background auto-approve, an autonomy `auto` policy, and
    // risk thresholds, which are exactly the holes that let a scheduled run send
    // email with no human in the loop. Drafting, reading, and internal
    // plumbing are unaffected (they classify as "draft"/"research", or are
    // excluded as internal-infra), so a background run can still prepare work
    // and park only at the consequential act.
    if (requiresHumanApprovalForAction(name, input)) {
      if (context.isInteractive === false) {
        // Unattended run (scheduled task / mission / heartbeat / background
        // wake): park as a needs-you item and deny the action. Never execute.
        void import("../work-items/work-item-approval-timeouts.js")
          .then((m) =>
            m.parkExternalSendForConversation(context.conversationId, name),
          )
          .catch(() => {});
        const durationMs = Date.now() - startTime;
        const reason =
          `Parked "${name}": this reaches outside or can't be undone, so it ` +
          `needs your approval and can't run unattended. I've saved it as a ` +
          `needs-you item — approve and re-run to do it. (Drafting and reading ` +
          `are fine; only the action itself waits for you.)`;
        emitLifecycleEvent({
          type: "permission_denied",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "deny",
          reason,
          durationMs,
        });
        return { allowed: false, result: { content: reason, isError: true } };
      }
      // Attended run: force a fresh, un-auto-approvable confirmation prompt —
      // even for the guardian/owner. Mutating the by-reference context is
      // honored downstream by the PermissionChecker, which excludes
      // `requireFreshApproval` from every auto-approve branch and promotes a
      // side-effect allow to a prompt. Falls through to the normal gates.
      context.requireFreshApproval = true;
      context.forcePromptSideEffects = true;
    }

    // Determine whether this invocation requires a scoped grant. Capture
    // the consume params now but defer the actual atomic consumption until
    // after all downstream policy gates (allowedToolNames, task-run
    // preflight, tool registry) pass. This prevents wasting a one-time-use
    // grant when a subsequent gate rejects the invocation.
    let needsGrantConsumption = false;
    let deferredConsumeParams:
      | Parameters<typeof consumeGrantForInvocation>[0]
      | null = null;

    const guardianApprovalRequired = requiresGuardianApprovalForActor(
      name,
      input,
      executionTarget,
    );

    if (isUntrustedTrustClass(context.trustClass) && guardianApprovalRequired) {
      const inputDigest = computeToolApprovalDigest(name, input);
      needsGrantConsumption = true;
      deferredConsumeParams = {
        requestId: context.requestId,
        toolName: name,
        inputDigest,
        consumingRequestId:
          context.requestId ??
          `preexec-${context.conversationId}-${Date.now()}`,
        executionChannel: context.executionChannel,
        conversationId: context.conversationId,
        callSessionId: context.callSessionId,
        requesterExternalUserId: context.requesterExternalUserId,
      };
    }

    if (
      context.diskPressureCleanupModeActive === true &&
      !isDiskPressureCleanupToolName(name)
    ) {
      const msg = `Tool "${name}" is not available during disk pressure cleanup mode.`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: "tool_failure",
      });
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Look up the tool before the allowedToolNames gate so a name no skill
    // provides surfaces as "Unknown tool" (with the real list) instead of
    // the misleading "load the skill" hint.
    const tool = getTool(name);
    if (!tool) {
      const allowedToolNames = context.allowedToolNames;
      // List every registered tool. Tools that need an external resolver
      // (computer-use, ui-surface, etc.) now return a structured error
      // from their `execute()` when no resolver is connected, rather than
      // being filtered out here — listing them surfaces a clearer path
      // than hiding their names entirely.
      const availableNames = getAllTools()
        .map((t) => t.name)
        .filter((n) => !allowedToolNames || allowedToolNames.has(n))
        .sort();
      const suggestion = suggestToolName(name, availableNames);
      const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : "";
      const msg = `Unknown tool: ${name}.${didYouMean} Available tools: ${availableNames.join(", ")}`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: "tool_failure",
      });
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Gate tools not active for the current turn
    if (context.allowedToolNames && !context.allowedToolNames.has(name)) {
      const owner = getToolOwner(name);
      const ownerSkillId = owner?.kind === "skill" ? owner.id : undefined;
      const loadHint = ownerSkillId
        ? `Load the "${ownerSkillId}" skill that provides this tool first.`
        : `Load the skill that provides this tool first.`;
      const msg = `Tool "${name}" is not currently active. ${loadHint}`;
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "error",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "error",
        durationMs,
        errorMessage: msg,
        isExpected: true,
        errorCategory: "tool_failure",
      });
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Enforce channel-scoped permission profiles (deterministic gate).
    // When the session originates from a Slack channel with a configured
    // permission profile, blocked tools and category restrictions are
    // enforced here rather than relying on model compliance with hints.
    if (
      context.executionChannel === "slack" &&
      context.channelPermissionChannelId
    ) {
      if (
        !isToolAllowedInChannel(
          context.channelPermissionChannelId,
          name,
          tool.category,
        )
      ) {
        const msg = `Tool "${name}" is not allowed in this channel per channel permission policy.`;
        log.warn(
          {
            toolName: name,
            channelId: context.channelPermissionChannelId,
            category: tool.category,
            conversationId: context.conversationId,
            reason: "channel_permission_policy",
          },
          "Channel permission policy blocked tool invocation",
        );
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent({
          type: "permission_denied",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "deny",
          reason: msg,
          durationMs,
        });
        return { allowed: false, result: { content: msg, isError: true } };
      }
    }

    // All deterministic policy gates passed. Parse model-generated input for
    // built-in tools with a registered schema BEFORE the grant consumption
    // and guardian escalation below: a malformed invocation can never
    // execute, so failing it here means it cannot burn a one-time grant or
    // interrupt the guardian with an approval card (and up to a 60s inline
    // wait) for a call validation would reject anyway. Extension-owned and
    // workspace-override tools own their input contracts and are skipped —
    // core tools are the ones with no `getToolOwner` entry.
    let parsedInput: Record<string, unknown> | undefined;
    if (getToolOwner(name) === undefined) {
      const parsed = parseToolInput(name, input);
      if (!parsed.ok) {
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent({
          type: "error",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "error",
          durationMs,
          errorMessage: parsed.message,
          isExpected: true,
          errorCategory: "tool_failure",
        });
        return {
          allowed: false,
          result: { content: parsed.message, isError: true },
        };
      }
      parsedInput = parsed.data;
    }

    // Now consume the scoped grant if one is required. Deferring consumption
    // to this point ensures a prior gate rejection (allowedToolNames, input
    // validation, registry lookup) does not waste the one-time-use grant.
    //
    // Retry polling is scoped to the voice channel where a race condition
    // exists between fire-and-forget turn execution and LLM fallback grant
    // minting (2-5s). Non-voice channels get an instant sync lookup so
    // normal denials are not delayed.
    if (needsGrantConsumption && deferredConsumeParams) {
      const isVoice = context.executionChannel === "phone";
      const grantResult = await consumeGrantForInvocation(
        deferredConsumeParams,
        isVoice ? { signal: context.signal } : { maxWaitMs: 0 },
      );

      if (grantResult.ok) {
        log.info(
          {
            toolName: name,
            conversationId: context.conversationId,
            trustClass: context.trustClass,
            executionTarget,
            grantId: grantResult.grant.id,
          },
          "Scoped grant consumed - allowing untrusted actor tool invocation",
        );

        return { allowed: true, tool, grantConsumed: true, parsedInput };
      }

      // Treat abort as a cancellation - not a grant denial. This matches
      // the abort check at the top of checkPreExecutionGates so the caller
      // sees a consistent "Cancelled" result instead of a spurious
      // guardian_approval_required denial during voice barge-in.
      if (grantResult.reason === "aborted") {
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent({
          type: "error",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          decision: "error",
          durationMs,
          errorMessage: "Cancelled",
          isExpected: true,
          errorCategory: "tool_failure",
        });
        return {
          allowed: false,
          result: { content: "Cancelled", isError: true },
        };
      }

      // No matching grant or race condition - deny or wait inline.
      //
      // For verified non-guardian actors (trusted_contact) with sufficient
      // context, escalate to the guardian by creating a canonical
      // tool_grant_request. Then wait bounded for the grant to become
      // available - this lets the tool call succeed inline after guardian
      // approval without the requester having to retry manually.
      //
      // Unverified actors remain fail-closed with no escalation or wait.
      if (
        context.trustClass === "trusted_contact" &&
        context.assistantId &&
        context.executionChannel &&
        context.requesterExternalUserId
      ) {
        const inputDigest =
          deferredConsumeParams?.inputDigest ??
          computeToolApprovalDigest(name, input);
        const escalation = createOrReuseToolGrantRequest({
          assistantId: context.assistantId,
          sourceChannel: context.executionChannel as ChannelId,
          conversationId: context.conversationId,
          requesterExternalUserId: context.requesterExternalUserId,
          requesterChatId: context.requesterChatId,
          toolName: name,
          inputDigest,
          questionText: buildToolGrantQuestionText(name, input, context),
          requesterIdentifier:
            context.requesterDisplayName || context.requesterIdentifier,
        });

        // Only wait inline if the escalation succeeded (created or deduped).
        // If escalation failed (no binding, missing identity), fall through
        // to the generic denial path.
        if ("created" in escalation || "deduped" in escalation) {
          // Stamp the canonical request so the approval resolver knows an
          // inline consumer is waiting. Without this, the resolver would
          // send a stale "please retry" notification even though the
          // original invocation is about to resume inline.
          updateCanonicalGuardianRequest(escalation.requestId, {
            followupState: "inline_wait_active:" + Date.now(),
          });

          const waitResult = await waitForInlineGrant(
            escalation.requestId,
            deferredConsumeParams!,
            {
              maxWaitMs: this.inlineGrantWaitConfig.maxWaitMs,
              intervalMs: this.inlineGrantWaitConfig.intervalMs,
              signal: context.signal,
            },
          );

          if (waitResult.outcome === "granted") {
            // Clear the inline-wait stamp now that the grant has been consumed.
            updateCanonicalGuardianRequest(escalation.requestId, {
              followupState: null,
            });
            log.info(
              {
                toolName: name,
                conversationId: context.conversationId,
                trustClass: context.trustClass,
                executionTarget,
                grantId: waitResult.grant.id,
                escalationRequestId: escalation.requestId,
              },
              "Inline grant wait succeeded - allowing trusted contact tool invocation",
            );
            return { allowed: true, tool, grantConsumed: true, parsedInput };
          }

          if (waitResult.outcome === "aborted") {
            // Clear the inline-wait stamp so a later guardian approval
            // (if the request is still pending) will send the retry notification.
            updateCanonicalGuardianRequest(escalation.requestId, {
              followupState: null,
            });
            const durationMs = Date.now() - startTime;
            emitLifecycleEvent({
              type: "error",
              toolName: name,
              executionTarget,
              input,
              workingDir: context.workingDir,
              conversationId: context.conversationId,
              requestId: context.requestId,
              riskLevel,
              decision: "error",
              durationMs,
              errorMessage: "Cancelled",
              isExpected: true,
              errorCategory: "tool_failure",
            });
            return {
              allowed: false,
              result: { content: "Cancelled", isError: true },
            };
          }

          // Clear the inline-wait stamp so a later guardian approval
          // (if the request is still pending after timeout) will send
          // the retry notification as expected.
          updateCanonicalGuardianRequest(escalation.requestId, {
            followupState: null,
          });

          const codeSuffix = escalation.requestCode
            ? ` (request code: ${escalation.requestCode})`
            : "";

          let escalationMessage: string;
          if (waitResult.outcome === "denied") {
            escalationMessage = `Permission denied for "${name}": the guardian rejected the request${codeSuffix}.`;
          } else {
            // timeout
            escalationMessage =
              `Permission denied for "${name}": guardian approval was not received in time${codeSuffix}. ` +
              `Please retry after the guardian approves.`;
          }

          log.warn(
            {
              toolName: name,
              conversationId: context.conversationId,
              trustClass: context.trustClass,
              executionTarget,
              reason: "guardian_approval_required",
              grantMissReason: grantResult.reason,
              waitOutcome: waitResult.outcome,
              escalationRequestId: escalation.requestId,
            },
            "Inline grant wait ended without approval - denying trusted contact tool invocation",
          );
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent({
            type: "permission_denied",
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            conversationId: context.conversationId,
            requestId: context.requestId,
            riskLevel,
            decision: "deny",
            reason: escalationMessage,
            durationMs,
          });
          return {
            allowed: false,
            result: { content: escalationMessage, isError: true },
          };
        }
        // escalation.failed - fall through to generic denial.
      }

      // Unknown/unverified actors or escalation failures - generic denial.
      const reason = guardianApprovalDeniedMessage(context.trustClass, name);
      log.warn(
        {
          toolName: name,
          conversationId: context.conversationId,
          trustClass: context.trustClass,
          executionTarget,
          reason: "guardian_approval_required",
          grantMissReason: grantResult.reason,
          escalated: false,
        },
        "Guardian approval gate blocked untrusted actor tool invocation (no matching grant)",
      );
      const durationMs = Date.now() - startTime;
      emitLifecycleEvent({
        type: "permission_denied",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel,
        decision: "deny",
        reason,
        durationMs,
      });
      return { allowed: false, result: { content: reason, isError: true } };
    }

    return { allowed: true, tool, parsedInput };
  }
}
