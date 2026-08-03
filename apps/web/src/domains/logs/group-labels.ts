import { NEUTRAL_MODEL_LABEL } from "@/assistant/use-managed-mode";
import type { UsageCallSiteMetadataMap } from "./call-site-metadata";
import type { UsageProfileMetadataMap } from "@/utils/profile-metadata";
import type { UsageGroupBreakdown, UsageGroupBy } from "./usage-types";

export interface UsageGroupLabelMetadata {
  callSites?: UsageCallSiteMetadataMap;
  profiles?: UsageProfileMetadataMap;
  /**
   * `hideVendorUi()` for the active instance. When true the `model` and
   * `provider` dimensions are already removed from the picker and coerced
   * out of the URL state — this is the last line of defense for the paths
   * that bypass both (a stale deep link, or the old-daemon group-by
   * fallback), so a raw slug can never reach the DOM.
   */
  hideVendor?: boolean;
}

/** Dimensions whose group value IS the vendor's own identifier. */
export function isVendorUsageGroupBy(groupBy: UsageGroupBy): boolean {
  return groupBy === "model" || groupBy === "provider";
}

export function resolveUsageGroupLabel(
  groupBy: UsageGroupBy,
  group: UsageGroupBreakdown,
  metadata: UsageGroupLabelMetadata,
): string {
  if (metadata.hideVendor && isVendorUsageGroupBy(groupBy)) {
    return NEUTRAL_MODEL_LABEL;
  }

  if (groupBy === "task") {
    const groupKey = group.groupKey;
    if (!groupKey) {
      return group.group;
    }

    return metadata.callSites?.[groupKey]?.displayName ?? group.group;
  }

  if (groupBy === "profile") {
    const groupKey = group.groupKey;
    if (!groupKey) {
      return group.group || "Default / Unset";
    }

    return metadata.profiles?.[groupKey]?.displayName ?? group.group;
  }

  return group.group;
}

export function decorateUsageBreakdownGroups(
  groups: UsageGroupBreakdown[],
  groupBy: UsageGroupBy,
  metadata: UsageGroupLabelMetadata,
): UsageGroupBreakdown[] {
  if (!groups || groups.length === 0) {
    return [];
  }

  return groups.map((group) => {
    const resolvedGroup = resolveUsageGroupLabel(groupBy, group, metadata);
    if (resolvedGroup === group.group) {
      return group;
    }

    return {
      ...group,
      group: resolvedGroup,
    };
  });
}
