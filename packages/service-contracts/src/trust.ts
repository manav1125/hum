/**
 * Trust classes and the admission-floor comparison, shared between the
 * assistant daemon and the gateway.
 *
 * Extracted from `assistant/src/runtime/actor-trust-resolver.ts` so that both
 * packages reference a single canonical definition. The reason this is a
 * shared contract rather than two copies is a specific failure shape: an
 * admission floor raised in one table, with no matching rank in the other,
 * does not fail loudly — it silently admits everyone. A gate that is wrong in
 * that direction reports success while it is doing the opposite of its job,
 * which is the hardest kind of defect to notice from the outside.
 *
 * Two properties defend against it:
 *
 * 1. **The rank table is exhaustive by type.** `Record<TrustClass, number>`
 *    means adding a class to the union without ranking it is a compile error,
 *    not a runtime zero.
 * 2. **Every unrecognized input denies.** An absent, malformed, or
 *    not-yet-known class ranks below every floor, and an unrecognized *floor*
 *    admits nobody. Both directions fail closed, so a version skew between two
 *    services degrades to "denied" rather than "allowed".
 *
 * This module is deliberately only the comparison. It does not decide who is
 * in which class, does not read config, and has no runtime dependencies —
 * classification stays with the service that owns the identity records.
 */

// ---------------------------------------------------------------------------
// Trust class
// ---------------------------------------------------------------------------

/**
 * Trust classification for an inbound actor.
 *
 * - `'guardian'`: the sender matches the active guardian binding for this
 *   (assistant, channel). Guardians have full control-plane access and
 *   self-approve tool invocations.
 * - `'trusted_contact'`: the sender is an active contact with a channel, but
 *   not the guardian. Trusted contacts can invoke tools but require guardian
 *   approval for sensitive operations.
 * - `'unknown'`: the sender has no contact record, no identity could be
 *   established, or the contact is inactive/revoked. Unknown actors are
 *   fail-closed with no escalation path.
 */
export type TrustClass = "guardian" | "trusted_contact" | "unknown";

/** Every trust class, ordered least to most trusted. */
export const TRUST_CLASSES: readonly TrustClass[] = [
  "unknown",
  "trusted_contact",
  "guardian",
] as const;

/**
 * Ordinal rank per class — higher is more trusted. Typed as an exhaustive
 * `Record` on purpose: a new class added to {@link TrustClass} without a rank
 * here fails the build, which is the whole point of hoisting this.
 */
export const TRUST_CLASS_RANK: Record<TrustClass, number> = {
  unknown: 0,
  trusted_contact: 1,
  guardian: 2,
};

/** Narrow an arbitrary value to a {@link TrustClass}. */
export function isTrustClass(value: unknown): value is TrustClass {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TRUST_CLASS_RANK, value)
  );
}

// ---------------------------------------------------------------------------
// Admission floor
// ---------------------------------------------------------------------------

/**
 * Numeric rank for a trust class. Anything not a known class ranks `-1` —
 * below `unknown` — so an unrecognized value can never clear a floor.
 */
export function trustClassRank(trustClass: unknown): number {
  return isTrustClass(trustClass) ? TRUST_CLASS_RANK[trustClass] : -1;
}

/**
 * Whether `actual` is trusted enough to clear `floor`.
 *
 * Fails closed in both directions. An unrecognized or absent `actual` denies,
 * because an actor we cannot classify is not an actor we can admit. An
 * unrecognized `floor` also denies — a caller asking for a bar this module has
 * never heard of is asking for a check it cannot perform, and answering "sure"
 * to a question you do not understand is how a gate ends up admitting
 * everyone.
 */
export function meetsAdmissionFloor(
  actual: TrustClass | undefined,
  floor: TrustClass,
): boolean {
  if (!isTrustClass(floor)) return false;
  return trustClassRank(actual) >= TRUST_CLASS_RANK[floor];
}

/**
 * `true` for actors that are not fully trusted — i.e. anyone below the
 * guardian, including an absent classification. The inverse of
 * `meetsAdmissionFloor(trustClass, "guardian")`, kept as a named predicate
 * because it reads better at the many call sites that gate on "is this the
 * owner or not".
 */
export function isUntrustedTrustClass(
  trustClass: TrustClass | undefined,
): boolean {
  return !meetsAdmissionFloor(trustClass, "guardian");
}
