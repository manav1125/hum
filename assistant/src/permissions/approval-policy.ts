import type { OwnerKind } from "../tools/types.js";
import type { AutonomyClass } from "./autonomy-class.js";
import type { TrustRule } from "./types.js";
import { RiskLevel } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Execution context for per-context threshold resolution. */
export type ExecutionContext = "conversation" | "background" | "headless";

/** Contextual information that an approval policy uses to reach a decision. */
export interface ApprovalContext {
  riskLevel: RiskLevel;
  toolName: string;
  matchedRule?: TrustRule;
  isContainerized: boolean;
  isWorkspaceScoped: boolean;
  /**
   * Owner kind of the tool, as recorded by the tool registry — "skill" /
   * "plugin" / "mcp" for extension-owned tools, `undefined` for core tools
   * (and for tools that aren't registered, e.g. unregistered skill tools
   * matched only via `hasManifestOverride`).
   */
  toolOrigin?: OwnerKind;
  /** Whether the tool's owning skill is a first-party bundled skill. */
  isSkillBundled?: boolean;
  /** Whether the tool has a manifest override (unregistered skill tool). */
  hasManifestOverride?: boolean;
  /** Whether the command's registry entry has sandboxAutoApprove: true. */
  hasSandboxAutoApprove?: boolean;
  /**
   * Resolved auto-approve threshold for this execution context.
   * - "none": prompt for everything (strictest)
   * - "low": auto-approve Low risk (default, matches existing behavior)
   * - "medium": auto-approve Low and Medium risk
   * - "high": auto-approve everything unconditionally
   */
  autoApproveUpTo?: "none" | "low" | "medium" | "high";
  /**
   * Per-task-type autonomy category this tool invocation falls into
   * (research / draft / send / money / delete / other). Informational —
   * `autonomyMode` is the field the policy acts on.
   */
  autonomyClass?: AutonomyClass;
  /**
   * The user's configured autonomy mode for this invocation's category.
   * - "never": deny unconditionally (high priority, after deny rules)
   * - "ask":   prompt unconditionally — holds even at a relaxed threshold /
   *            Full access
   * - "auto":  fall through to the existing risk-based logic (still honors
   *            deny rules and risk)
   * `undefined` preserves the pre-existing behavior (no category gating).
   */
  autonomyMode?: "auto" | "ask" | "never";
}

// ── Ordinal maps for threshold comparison ─────────────────────────────────────
// Hoisted to module level since these are constant. Unknown enum values
// conservatively map to the strictest interpretation: risk defaults to 2 (high)
// and threshold defaults to 0 (low).
const RISK_ORDINAL: Record<string, number> = { low: 0, medium: 1, high: 2 };
const THRESHOLD_ORDINAL: Record<string, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Check whether a risk level falls within the configured auto-approve threshold.
 * Returns `true` when the risk is at or below the threshold (i.e. auto-approve).
 */
function isRiskWithinThreshold(
  riskLevel: string,
  autoApproveUpTo: string | undefined,
): boolean {
  const risk = RISK_ORDINAL[riskLevel] ?? 2;
  const threshold = THRESHOLD_ORDINAL[autoApproveUpTo ?? "low"] ?? 0;
  return risk <= threshold;
}

/** The outcome of an approval policy evaluation. */
export interface ApprovalDecision {
  decision: "allow" | "prompt" | "deny";
  reason: string;
  /** Present only when the decision was driven by a matched rule. */
  matchedRule?: TrustRule;
  /**
   * True when a "prompt" was forced by the per-category autonomy mode
   * (send/money/delete/publish/contact defaults or an enabled guardrail
   * checkpoint). Downstream shortcuts (temporary approval overrides) must
   * not auto-approve prompts carrying this flag.
   */
  enforcedByAutonomyPolicy?: boolean;
}

/** An object that evaluates an approval context and returns a decision. */
export interface ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision;
}

// ── Default implementation ───────────────────────────────────────────────────

/**
 * Implements the approval decision policy used by `check()` in checker.ts.
 *
 * The decision flow:
 *
 * 1. Deny rule → deny
 * 2. Ask rule + risk > autoApproveUpTo → prompt
 *    Ask rule + risk ≤ autoApproveUpTo → allow (threshold overrides ask rule)
 *    Exception: skill_load_dynamic ask rules always prompt (inline-command safety gate)
 * 3. Sandbox auto-approve: bash + sandboxAutoApprove + autoApproveUpTo !== "none" → allow
 *    (Path resolution is baked into `hasSandboxAutoApprove` upstream: containerized
 *    environments skip path checks; non-containerized environments validate all
 *    path arguments against the workspace root.)
 * 4. Allow rule + non-High → allow
 * 5. Allow rule + High → fall through to risk-based
 * 6. No rule + third-party skill tool + risk > autoApproveUpTo → prompt
 *    No rule + third-party skill tool + risk ≤ autoApproveUpTo → allow (threshold overrides)
 * 7. No rule + Low + workspace-scoped + within threshold → allow
 * 8. No rule + Low + bundled skill + within threshold → allow
 * 9. Risk ≤ autoApproveUpTo threshold → allow
 * 10. Risk > autoApproveUpTo threshold → prompt
 */
export class DefaultApprovalPolicy implements ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision {
    const {
      riskLevel,
      toolName,
      matchedRule,
      isWorkspaceScoped,
      toolOrigin,
      isSkillBundled,
      hasManifestOverride,
      hasSandboxAutoApprove,
    } = context;

    // ── 1. Deny rules apply at ALL risk levels ────────────────────────
    if (matchedRule && matchedRule.decision === "deny") {
      return {
        decision: "deny",
        reason: `Blocked by deny rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // ── 1b. Per-category autonomy mode (high priority) ─────────────────
    // The user's per-task-type autonomy setting is evaluated immediately
    // after deny rules and BEFORE any threshold/override logic. This is
    // additive and can only make the decision stricter:
    //   - "never": deny — the user has forbidden this category outright.
    //   - "ask":   prompt UNCONDITIONALLY. This must hold even when the
    //              auto-approve threshold would otherwise allow the risk
    //              (e.g. Full access) — "ask" is the user explicitly opting
    //              this category out of auto-run, so it defeats a relaxed
    //              threshold. We do NOT consult autoApproveUpTo here.
    //   - "auto":  fall through to the existing risk-based logic below; auto
    //              still respects deny rules and risk-based prompting.
    //   - undefined: no category gating — preserve pre-existing behavior.
    const { autonomyMode } = context;
    if (autonomyMode === "never") {
      return {
        decision: "deny",
        reason: "category set to never",
      };
    }
    if (autonomyMode === "ask") {
      return {
        decision: "prompt",
        reason: "category requires approval",
        enforcedByAutonomyPolicy: true,
      };
    }

    // ── 2. Ask rules prompt — unless the threshold covers the risk.
    // The user's threshold setting takes precedence over ask rules: if the
    // risk falls within autoApproveUpTo, the ask rule is overridden and
    // the tool auto-approves.
    // Exception: skill_load_dynamic ask rules always prompt — they gate
    // inline-command skill loads that execute embedded commands and must
    // never be silently auto-approved.
    if (matchedRule && matchedRule.decision === "ask") {
      const isDynamicSkillAsk = matchedRule.pattern.startsWith(
        "skill_load_dynamic:",
      );
      if (
        !isDynamicSkillAsk &&
        isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
      ) {
        return {
          decision: "allow",
          reason: `${riskLevel} risk: within auto-approve threshold (ask rule overridden)`,
        };
      }
      return {
        decision: "prompt",
        reason: `Matched ask rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // ── 3. Sandbox auto-approve: bash + allowlisted → allow ──
    // Respects the autoApproveUpTo threshold: when set to "none", sandbox
    // auto-approve is suppressed — the user wants to approve everything.
    // Path resolution is baked into `hasSandboxAutoApprove` upstream:
    // containerized environments skip path checks (entire fs is workspace),
    // non-containerized environments validate all path args against workspace root.
    if (
      toolName === "bash" &&
      hasSandboxAutoApprove === true &&
      context.autoApproveUpTo !== "none"
    ) {
      return {
        decision: "allow",
        reason: "Workspace filesystem operation (sandbox auto-approve)",
      };
    }

    // ── 4–5. Allow rule handling ──────────────────────────────────────
    if (matchedRule) {
      if (riskLevel !== RiskLevel.High) {
        return {
          decision: "allow",
          reason: `Matched trust rule: ${matchedRule.pattern}`,
          matchedRule,
        };
      }
      // High risk: fall through to risk-based regardless of rule
    }

    // ── 6. No rule + third-party skill tool → prompt (unless threshold covers it)
    if (!matchedRule) {
      // Plugin- and skill-owned tools are both treated as extension-class
      // for approval purposes: external by default, prompt unless bundled.
      // MCP-owned tools fall through to the core risk-based path.
      const isExtensionOwned =
        toolOrigin === "skill" || toolOrigin === "plugin";
      const isThirdPartySkill =
        (isExtensionOwned && !isSkillBundled) ||
        (hasManifestOverride && !toolOrigin);
      if (isThirdPartySkill) {
        if (isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)) {
          return {
            decision: "allow",
            reason: `${riskLevel} risk: within auto-approve threshold (skill tool)`,
          };
        }
        return {
          decision: "prompt",
          reason: "Skill tool: requires approval by default",
        };
      }
    }

    // ── 7. No rule + Low + workspace-scoped + within threshold → allow ──
    if (
      !matchedRule &&
      riskLevel === RiskLevel.Low &&
      isWorkspaceScoped &&
      isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
    ) {
      return {
        decision: "allow",
        reason: "Workspace-scoped low-risk operation auto-allowed",
      };
    }

    // ── 8. No rule + Low + bundled skill + within threshold → allow ──
    if (
      !matchedRule &&
      riskLevel === RiskLevel.Low &&
      toolOrigin === "skill" &&
      isSkillBundled &&
      isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
    ) {
      return {
        decision: "allow",
        reason: "Bundled skill tool: low risk, auto-allowed",
      };
    }

    // ── 9–10. Risk-based fallback: compare risk against configured threshold ─
    if (isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)) {
      return {
        decision: "allow",
        reason: `${riskLevel} risk: within auto-approve threshold`,
      };
    }
    return {
      decision: "prompt",
      reason: `${riskLevel} risk: above auto-approve threshold`,
    };
  }
}
