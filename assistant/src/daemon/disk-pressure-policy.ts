import type { InterfaceId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { DiskPressureStatus } from "./disk-pressure-guard.js";
import type { ConversationType } from "./message-types/shared.js";
import type { TrustContext } from "./trust-context.js";

export type DiskPressureCleanupReason = "local-owner" | "guardian";

export type DiskPressureBlockReason =
  | "background"
  | "trusted-contact"
  | "non-guardian"
  | "unknown-remote";

export type DiskPressureTurnPolicyDecision =
  | { action: "allow-normal" }
  | { action: "allow-cleanup-mode"; reason: DiskPressureCleanupReason }
  | { action: "block"; reason: DiskPressureBlockReason };

export type DiskPressureTurnTrustClass =
  | TrustContext["trustClass"]
  | "non_guardian"
  | "non-guardian"
  | (string & {});

export interface DiskPressureTurnTrustContext {
  sourceChannel?: TrustContext["sourceChannel"] | (string & {});
  trustClass?: DiskPressureTurnTrustClass;
}

export interface DiskPressureTurnMetadata {
  conversationType?: ConversationType | (string & {}) | null;
  conversationGroupId?: string | null;
  conversationSource?: string | null;
  callSite?: LLMCallSite | (string & {}) | null;
  isInteractive?: boolean | null;
  sourceChannel?: TrustContext["sourceChannel"] | (string & {}) | null;
  sourceInterface?: InterfaceId | "vellum" | (string & {}) | null;
  trustContext?: DiskPressureTurnTrustContext | null;
  isDirectWake?: boolean | null;
}

const BACKGROUND_CONVERSATION_TYPES = new Set(["background", "scheduled"]);
const BACKGROUND_GROUP_IDS = new Set(["system:background", "system:scheduled"]);
const BACKGROUND_SOURCES = new Set([
  "auto-analysis",
  "background",
  "compaction",
  "direct",
  "filing",
  "heartbeat",
  "memory",
  "notification",
  "reminder",
  "schedule",
  "task",
]);
const LOCAL_OWNER_INTERFACES = new Set(["macos", "web", "vellum", "cli"]);

export function classifyDiskPressureTurnPolicy(
  status: DiskPressureStatus,
  metadata: DiskPressureTurnMetadata,
): DiskPressureTurnPolicyDecision {
  if (!status.enabled || !status.locked || status.overrideActive) {
    return { action: "allow-normal" };
  }

  if (!status.effectivelyLocked) {
    return { action: "allow-normal" };
  }

  if (isBackgroundTurn(metadata)) {
    return { action: "block", reason: "background" };
  }

  const trustClass = metadata.trustContext?.trustClass;
  if (trustClass === "guardian") {
    return { action: "allow-cleanup-mode", reason: "guardian" };
  }

  if (trustClass === "trusted_contact") {
    return { action: "block", reason: "trusted-contact" };
  }

  if (isNonGuardianTrustClass(trustClass)) {
    return { action: "block", reason: "non-guardian" };
  }

  // Local-owner foreground turn check runs *before* the `unknown`-trust block.
  //
  // A self-hosted actor sending from the owner's own app arrives on channel
  // `vellum` over a local-owner interface (`web`/`macos`/`ios`/`cli`). Its JWT
  // is resolved through the guardian-binding trust pipeline, which can yield
  // `trustClass: "unknown"` when the binding has drifted (e.g. a DB reset or a
  // workspace migration that re-minted the guardian principal id while the
  // client still holds a valid actor JWT). That actor is the local owner, not a
  // remote sender — remote senders only ever reach this classifier on a
  // channel-specific interface (telegram/slack/email/phone/whatsapp), never on
  // `vellum`+local-owner. Treating the drifted-owner turn as "unknown-remote"
  // here silently blocks the owner's foreground agent turn under disk pressure
  // (the turn no-ops with only a transient SSE error and persists nothing), so
  // the local-owner channel/interface signal takes precedence over the
  // `unknown` trust class.
  if (isLocalOwnerForegroundTurn(metadata)) {
    return { action: "allow-cleanup-mode", reason: "local-owner" };
  }

  if (trustClass === "unknown") {
    return { action: "block", reason: "unknown-remote" };
  }

  if (trustClass !== undefined) {
    return { action: "block", reason: "non-guardian" };
  }

  return { action: "block", reason: "unknown-remote" };
}

function isBackgroundTurn(metadata: DiskPressureTurnMetadata): boolean {
  if (isExplicitLocalOwnerCleanupTurn(metadata)) return false;
  if (metadata.isDirectWake) return true;
  if (metadata.callSite != null && metadata.callSite !== "mainAgent") {
    return true;
  }
  if (
    metadata.conversationType != null &&
    BACKGROUND_CONVERSATION_TYPES.has(metadata.conversationType)
  ) {
    return true;
  }
  if (
    metadata.conversationGroupId != null &&
    BACKGROUND_GROUP_IDS.has(metadata.conversationGroupId)
  ) {
    return true;
  }
  return (
    metadata.conversationSource != null &&
    BACKGROUND_SOURCES.has(metadata.conversationSource)
  );
}

function isNonGuardianTrustClass(
  trustClass: DiskPressureTurnTrustClass | undefined,
): boolean {
  return trustClass === "non_guardian" || trustClass === "non-guardian";
}

/**
 * True for the local owner's own foreground turn: channel `vellum` over a
 * local-owner interface (`web`/`macos`/`ios`/`cli`/`vellum`).
 *
 * Accepts both the no-trust case (trust never resolved) and the
 * `unknown`-trust case (guardian-binding drift on a self-hosted actor JWT —
 * see the call site for why a `vellum`+local-owner turn that resolved to
 * `unknown` is the owner, not a remote sender). Any other resolved trust class
 * (`guardian`/`trusted_contact`/`non_guardian`) is handled by the earlier
 * branches and never reaches here.
 */
function isLocalOwnerForegroundTurn(
  metadata: DiskPressureTurnMetadata,
): boolean {
  const trustClass = metadata.trustContext?.trustClass;
  if (trustClass != null && trustClass !== "unknown") return false;

  const channel = metadata.sourceChannel;
  const sourceInterface = metadata.sourceInterface;
  if (channel !== "vellum" || sourceInterface == null) return false;
  return LOCAL_OWNER_INTERFACES.has(sourceInterface);
}

function isExplicitLocalOwnerCleanupTurn(
  metadata: DiskPressureTurnMetadata,
): boolean {
  if (metadata.isDirectWake !== true) return false;
  const sourceInterface = metadata.sourceInterface;
  if (
    metadata.sourceChannel !== "vellum" ||
    sourceInterface == null ||
    !LOCAL_OWNER_INTERFACES.has(sourceInterface)
  ) {
    return false;
  }
  return (
    metadata.trustContext == null ||
    metadata.trustContext.trustClass === "guardian"
  );
}
