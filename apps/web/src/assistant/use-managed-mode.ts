/**
 * Managed-mode detection for HQ-provisioned (Cue-hosted) instances.
 *
 * Managed instances run with CUE_MANAGED=1 and their daemon advertises
 * `capabilities.managed` on the scope-less `/healthz` route. Customers on
 * managed instances must never see LLM-vendor machinery (API-key entry,
 * provider/model pickers, BYO settings), so vendor-y surfaces gate on the
 * value returned here.
 *
 * FLASH POLICY (deliberate): while the healthz fetch is still in flight the
 * hook returns `undefined`, and callers hide vendor UI whenever the value is
 * anything other than a confirmed `false` (`managed !== false`). A brief
 * flash of a *missing* settings section for a self-hoster is harmless — it
 * pops in a moment later — whereas a flash of API-key fields / vendor model
 * names on a managed customer's screen is exactly what this feature exists
 * to prevent. Two deliberate carve-outs resolve to `false` (self-host
 * semantics) so existing users are never soft-locked:
 *   - no active assistant selected (e.g. local-mode onboarding, pre-hatch):
 *     there is no connected instance that could be managed;
 *   - healthz errored (daemon unreachable): behave exactly like today's
 *     self-host UI rather than hiding settings forever.
 */

import { useQuery } from "@tanstack/react-query";

import { healthzGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Pure derivation, split out so it can be unit-tested without rendering.
 *
 * @returns `true` (managed), `false` (confirmed self-host), or `undefined`
 *   (still resolving — callers must keep vendor UI hidden).
 */
export function deriveManagedMode(input: {
  hasAssistant: boolean;
  isError: boolean;
  data: HealthzGetResponse | undefined;
}): boolean | undefined {
  if (!input.hasAssistant) return false;
  if (input.data) {
    // Old daemons without the field are self-host by definition — only an
    // explicit `true` from the instance turns managed mode on.
    return input.data.capabilities?.managed === true;
  }
  if (input.isError) return false;
  return undefined;
}

/**
 * Reactive managed-mode flag for the active assistant.
 *
 * `undefined` means "not yet known" — per the flash policy above, treat it
 * the same as managed (hide vendor UI) by gating on `managed !== false`.
 */
export function useManagedMode(): boolean | undefined {
  // Raw store read (not useActiveAssistantId) so the hook is safe outside
  // ActiveAssistantGate-guarded routes, e.g. onboarding screens.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const query = useQuery({
    ...healthzGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    // Instance-level deployment fact — it cannot change without the daemon
    // restarting, so never refetch within a session.
    staleTime: Infinity,
    retry: 1,
  });

  return deriveManagedMode({
    hasAssistant: !!assistantId,
    isError: query.isError,
    data: query.data,
  });
}

/**
 * Convenience predicate for gates: hide vendor UI unless the instance is a
 * *confirmed* self-host (`managed === false`). See flash policy above.
 */
export function hideVendorUi(managed: boolean | undefined): boolean {
  return managed !== false;
}

/**
 * Hook form of {@link hideVendorUi} — the one-liner most render bodies want.
 */
export function useHideVendorUi(): boolean {
  return hideVendorUi(useManagedMode());
}

/**
 * What a managed instance shows where a model name would otherwise go.
 *
 * Deliberately generic. The rule is show-nothing-or-show-this: never
 * substitute a *different* vendor's name. A plausible-but-false attribution
 * ("running on Claude") is worse than the leak it replaces — it is a claim
 * the product cannot stand behind, and the identity work that prompted this
 * change caught exactly that failure coming out of an ungated model.
 */
export const NEUTRAL_MODEL_LABEL = "Cue's model";

/**
 * Render helper for a model / provider string that arrives as *data* (a
 * usage rollup row, a ledger act, a settings subtitle) rather than as a
 * literal in the source.
 *
 * Component-level gates cannot cover these: the leak is a server-supplied
 * value flowing through a generic renderer, so the substitution has to
 * happen at the point of display.
 *
 * @param name  the model or provider string from the daemon
 * @param hide  the result of {@link hideVendorUi} / {@link useHideVendorUi}
 */
export function vendorSafeModelLabel(
  name: string | null | undefined,
  hide: boolean,
): string | null {
  if (hide) return NEUTRAL_MODEL_LABEL;
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
