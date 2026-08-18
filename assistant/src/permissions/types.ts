export type {
  AllowlistOption,
  ScopeOption,
} from "@vellumai/skill-host-contracts";
export { RiskLevel } from "@vellumai/skill-host-contracts";

export type ApprovalMode = "prompted" | "auto" | "blocked" | "unknown";

export type ApprovalReason =
  | "user_approved"
  | "user_denied"
  | "timed_out"
  | "within_threshold"
  | "trust_rule_allowed"
  | "trust_rule_denied"
  | "sandbox_auto_approve"
  | "platform_auto_approve"
  | "no_interactive_client"
  /**
   * Denied because the owner's per-category autonomy policy marks this class
   * of action "ask" and the run had no human to ask. Distinct from
   * `no_interactive_client`, which covers prompts reached on the risk path:
   * this one would still have been a prompt at any risk level.
   */
  | "autonomy_policy_ask"
  | "grant_scoped_consumed"
  | "system_cancelled"
  | "unknown";

export type RiskThreshold = "none" | "low" | "medium" | "high";

export const RISK_ORDINAL: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export const THRESHOLD_ORDINAL: Record<string, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
};

/** A persistent trust rule stored on disk and used for permission matching. */
export interface TrustRule {
  id: string;
  tool: string;
  pattern: string;
  decision: "allow" | "deny" | "ask";
  priority: number;
  createdAt: number;
  scope?: string;
  executionTarget?: string;
  userModifiedAt?: number;
}

/**
 * A user's answer to an interactive permission prompt.
 *
 * `allow_10m` / `allow_conversation` are temporary approval grants (recovered
 * from upstream e05896063f / 46d64df40d^): they approve the current action AND
 * install an ephemeral per-conversation override so subsequent eligible
 * prompts auto-approve (see runtime/conversation-approval-overrides.ts).
 */
export type UserDecision =
  | "allow"
  | "allow_10m"
  | "allow_conversation"
  | "deny";

/**
 * Returns true for any allow-variant decision. Centralizes the check to
 * prevent omissions when new allow variants are added — never compare a
 * UserDecision against the literal "allow" to mean "approved".
 */
export function isAllowDecision(decision: UserDecision): boolean {
  return (
    decision === "allow" ||
    decision === "allow_10m" ||
    decision === "allow_conversation"
  );
}

export interface PermissionCheckResult {
  decision: "allow" | "deny" | "prompt";
  reason: string;
  matchedRule?: TrustRule;
  /** True when the decision was taken via the sandbox auto-approve path. */
  hasSandboxAutoApprove?: boolean;
  /**
   * True when a "prompt" decision was forced by the per-category autonomy
   * policy / guardrail checkpoint layer (send, money, delete, publish,
   * contact classes or an enabled `autonomy:<class>` checkpoint). Temporary
   * approval overrides must NEVER auto-approve these prompts — the
   * checkpoint still fires and a human answers each one.
   */
  autonomyAskEnforced?: boolean;
}

/** Contextual information passed alongside a permission check for policy decisions. */
export interface PolicyContext {
  executionTarget?: string;
  /**
   * Execution context for per-context threshold resolution.
   * - "conversation": interactive client session (default)
   * - "background": non-interactive guardian session (e.g. scheduled jobs)
   * - "headless": non-interactive non-guardian session
   */
  executionContext?: "conversation" | "background" | "headless";
  /** Conversation ID for per-conversation threshold overrides. */
  conversationId?: string;
}
