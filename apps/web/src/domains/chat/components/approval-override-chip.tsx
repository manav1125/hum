/**
 * Live countdown chip for an active temporary approval override
 * (allow_10m / allow_conversation).
 *
 * Rendered near the composer while the daemon is auto-approving eligible
 * confirmations for this conversation. Shows the remaining time for timed
 * grants ("auto-approving · 9:42 left") and offers tap-to-revoke, which
 * calls POST /v1/approval-override/clear and returns the conversation to
 * per-action prompts.
 *
 * Ticking is purely local against the `expiresAt` the confirm response
 * echoed; the daemon expires the override lazily on its own, so a drifted
 * chip can only under-report, never extend, the grant. When the local
 * countdown reaches zero the chip clears itself — expiry never auto-allows
 * anything, so there is nothing to confirm with the server.
 */

import { ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";

import { clearApprovalOverride } from "@/domains/chat/api/interactions";
import { useApprovalOverrideStore } from "@/domains/chat/approval-override-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { captureError } from "@/lib/sentry/capture-error";

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ApprovalOverrideChip() {
  const activeOverride = useApprovalOverrideStore.use.activeOverride();
  const activeConversationKey = useConversationStore.use.activeConversationId();
  const [isRevoking, setIsRevoking] = useState(false);
  // Local 1s tick while a timed grant is active.
  const [now, setNow] = useState(() => Date.now());

  const isTimed = activeOverride?.kind === "timed";

  useEffect(() => {
    if (!isTimed) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isTimed]);

  // Local expiry: drop the chip once the countdown lapses. Display-only —
  // the daemon expires the authoritative override lazily on its own.
  useEffect(() => {
    if (
      activeOverride?.kind === "timed" &&
      activeOverride.expiresAt !== null &&
      now >= activeOverride.expiresAt
    ) {
      useApprovalOverrideStore.getState().clearActiveOverride();
    }
  }, [activeOverride, now]);

  if (!activeOverride) return null;
  // Scope the chip to the conversation that granted it (when known).
  if (
    activeOverride.conversationKey !== null &&
    activeConversationKey !== null &&
    activeOverride.conversationKey !== activeConversationKey
  ) {
    return null;
  }

  const remainingMs =
    activeOverride.kind === "timed" && activeOverride.expiresAt !== null
      ? activeOverride.expiresAt - now
      : null;
  if (remainingMs !== null && remainingMs <= 0) return null;

  const scopeLabel =
    remainingMs !== null
      ? `${formatRemaining(remainingMs)} left`
      : "this conversation";

  const revoke = async () => {
    if (isRevoking) return;
    setIsRevoking(true);
    // Clear locally first so the chip never outlives the user's intent —
    // the worst case of a failed revoke call is an extra prompt, never an
    // extra auto-approval the user didn't want removed.
    const { conversationId } = activeOverride;
    useApprovalOverrideStore.getState().clearActiveOverride();
    try {
      const ctx = useStreamStore.getState().streamContext;
      if (ctx) {
        await clearApprovalOverride(ctx.assistantId, conversationId);
      }
    } catch (err) {
      captureError(err, { context: "revoke_approval_override" });
    } finally {
      setIsRevoking(false);
    }
  };

  return (
    <div className="mb-2 flex justify-end">
      <button
        type="button"
        data-slot="approval-override-chip"
        onClick={() => void revoke()}
        disabled={isRevoking}
        title="Tap to stop auto-approving and return to per-action prompts"
        className="group flex items-center gap-1.5 rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] px-2.5 py-1 transition-colors hover:border-[var(--accent-cue)] disabled:opacity-50"
      >
        <ShieldCheck className="h-3 w-3 text-[var(--accent-cue)]" />
        {/* typography: off-scale — compact status chip */}
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--content-tertiary)]">
          auto-approving · {scopeLabel}
        </span>
        <X className="h-3 w-3 text-[var(--content-tertiary)] transition-colors group-hover:text-[var(--content-default)]" />
      </button>
    </div>
  );
}
