/**
 * Data hooks for the HQ first-run flow — thin wrappers over the generated
 * daemon SDK, kept local so the onboarding dir stays self-contained (no
 * dependency on the hq-page module graph other agents own).
 *
 *  · company profile (GET/PUT)   — identity, direction, workspaceMode
 *  · channel catalog + readiness — the real "connect your world" sources
 *  · captured work items         — the honest "already found" proof band
 *    (real counts only; the band renders nothing when the feed is empty)
 *  · missions POST               — the first mission
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  channelsAvailableGetOptions,
  channelsReadinessGetOptions,
  companyprofileGetOptions,
  companyprofileGetQueryKey,
  companyprofilePutMutation,
  missionsGetQueryKey,
  missionsPostMutation,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ChannelsAvailableGetResponses,
  ChannelsReadinessGetResponses,
  CompanyprofileGetResponses,
  WorkitemsGetResponses,
} from "@/generated/daemon/types.gen";

export type CompanyProfile = CompanyprofileGetResponses[200]["profile"];
export type WorkspaceMode = CompanyProfile["workspaceMode"];
type AvailableChannel = ChannelsAvailableGetResponses[200] extends {
  channels: Array<infer T>;
}
  ? T
  : never;
type ReadinessSnapshot =
  ChannelsReadinessGetResponses[200]["snapshots"][number];
export type FeedItem = WorkitemsGetResponses[200]["items"][number];

export function useCompanyProfile(assistantId: string) {
  const query = useQuery({
    ...companyprofileGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  return {
    profile: query.data?.profile ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** PUT company-profile — send only the fields being changed. */
export function usePutCompanyProfile(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...companyprofilePutMutation(),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: companyprofileGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      }),
  });
}

/** One connectable source card — real catalog entry + live readiness. */
export interface SourceCard {
  id: string;
  label: string;
  subtitle: string;
  icon: string;
  connected: boolean;
}

/** Channel ids that make sense as first-run source cards. */
const CONNECTABLE = ["email", "slack", "whatsapp", "telegram", "phone"];

/**
 * The real connect-your-world cards: daemon channel catalog merged with live
 * readiness snapshots (same sources the Channels page manages). Refetches on
 * window focus so a connect completed in the contacts surface shows up when
 * the user comes back to setup.
 */
export function useSourceCards(assistantId: string): {
  cards: SourceCard[];
  connectedIds: string[];
  isLoading: boolean;
} {
  const catalog = useQuery({
    ...channelsAvailableGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 60_000,
  });
  const readiness = useQuery({
    ...channelsReadinessGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  const channels = (catalog.data?.channels ?? []) as AvailableChannel[];
  const snapshots: ReadinessSnapshot[] = readiness.data?.snapshots ?? [];
  const readyByChannel = new Map<string, boolean>();
  for (const s of snapshots) readyByChannel.set(s.channel, s.ready === true);

  const cards: SourceCard[] = CONNECTABLE.flatMap((id) => {
    const ch = channels.find((c) => (c as { id?: string }).id === id) as
      { id: string; label: string; subtitle: string; icon: string } | undefined;
    if (!ch) return [];
    return [
      {
        id: ch.id,
        label: ch.label,
        subtitle: ch.subtitle,
        icon: ch.icon,
        connected: readyByChannel.get(ch.id) === true,
      },
    ];
  });

  return {
    cards,
    connectedIds: cards.filter((c) => c.connected).map((c) => c.id),
    isLoading: catalog.isLoading || readiness.isLoading,
  };
}

/** Whether a captured item's sourceType belongs to one of these channels. */
function itemFromChannels(item: FeedItem, channelIds: string[]): boolean {
  const t = (item.sourceType ?? "").toLowerCase();
  if (t.length === 0) return false;
  return channelIds.some((id) => {
    if (id === "email") return t.includes("mail") || t.includes("email");
    if (id === "phone") return t.includes("phone") || t.includes("call");
    return t.includes(id);
  });
}

/**
 * The "already found" proof band data — REAL captured work items whose source
 * matches a connected channel. Never fabricated: when the feed has nothing,
 * the band simply doesn't render. (A dedicated post-connect quick-scan is
 * future backend work; this reads what capture has already filed.)
 */
export function useAlreadyFound(
  assistantId: string,
  connectedIds: string[],
): { count: number; titles: string[] } {
  const query = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: {},
    }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    enabled: connectedIds.length > 0,
  });
  if (connectedIds.length === 0) return { count: 0, titles: [] };
  const matched = (query.data?.items ?? [])
    .filter((item) => itemFromChannels(item, connectedIds))
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    count: matched.length,
    titles: matched.slice(0, 3).map((i) => i.title),
  };
}

export function useCreateMission(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...missionsPostMutation(),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: missionsGetQueryKey({ path: { assistant_id: assistantId } }),
      }),
  });
}
