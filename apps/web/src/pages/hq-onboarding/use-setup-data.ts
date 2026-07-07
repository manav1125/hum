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
  connectorappsConnectPostMutation,
  connectorappsGetOptions,
  connectorappsGetQueryKey,
  missionsGetQueryKey,
  missionsPostMutation,
  secretsPostMutation,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ChannelsAvailableGetResponses,
  ChannelsReadinessGetResponses,
  CompanyprofileGetResponses,
  ConnectorappsGetResponses,
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

// ---------------------------------------------------------------------------
// Connect-tools grid (onboarding-v2) — Composio-connectable apps
// ---------------------------------------------------------------------------

export type ConnectorAppItem =
  ConnectorappsGetResponses[200]["apps"][number];

/**
 * Client-side floor for the connect grid: the same curated top-apps set the
 * daemon falls back to when Composio is unreachable. Used only when the
 * daemon itself can't be reached (fresh instance still waking, self-host
 * without the route) so the onboarding grid never renders a void.
 * `connected` is honestly false — we can't know without the daemon.
 */
const CURATED_CONNECTOR_APPS: ConnectorAppItem[] = (
  [
    ["gmail", "Gmail", "Email"],
    ["googlecalendar", "Google Calendar", "Calendar"],
    ["googledrive", "Google Drive", "Files"],
    ["googledocs", "Google Docs", "Documents"],
    ["googlesheets", "Google Sheets", "Documents"],
    ["notion", "Notion", "Documents"],
    ["slack", "Slack", "Messaging"],
    ["discord", "Discord", "Messaging"],
    ["telegram", "Telegram", "Messaging"],
    ["outlook", "Outlook", "Email"],
    ["onedrive", "OneDrive", "Files"],
    ["dropbox", "Dropbox", "Files"],
    ["github", "GitHub", "Developer"],
    ["linear", "Linear", "Project management"],
    ["jira", "Jira", "Project management"],
    ["asana", "Asana", "Project management"],
    ["trello", "Trello", "Project management"],
    ["clickup", "ClickUp", "Project management"],
    ["airtable", "Airtable", "Databases"],
    ["hubspot", "HubSpot", "CRM"],
    ["salesforce", "Salesforce", "CRM"],
    ["intercom", "Intercom", "Support"],
    ["zendesk", "Zendesk", "Support"],
    ["zoom", "Zoom", "Meetings"],
    ["calendly", "Calendly", "Calendar"],
    ["stripe", "Stripe", "Payments"],
    ["shopify", "Shopify", "Commerce"],
    ["figma", "Figma", "Design"],
    ["linkedin", "LinkedIn", "Social"],
    ["reddit", "Reddit", "Social"],
  ] as const
).map(([slug, name, category]) => ({
  slug,
  name,
  category,
  connected: false,
}));

/**
 * The Composio-connectable app grid for the onboarding connect step and the
 * command-center Integrations tile. Server-side fetched + cached by the
 * daemon (`GET /v1/connector-apps`); refetches on focus so a connect
 * completed in the OAuth tab shows up when the user returns.
 */
export function useConnectorApps(
  assistantId: string,
  query: string,
): {
  apps: ConnectorAppItem[];
  connectedCount: number;
  /** Whether easy-connect can actually start (daemon + Composio creds). */
  connectable: boolean;
  isLoading: boolean;
} {
  const q = useQuery({
    ...connectorappsGetOptions({
      path: { assistant_id: assistantId },
      // Filter client-side so typing doesn't refetch per keystroke.
      query: {},
    }),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const all: ConnectorAppItem[] = q.isError
    ? CURATED_CONNECTOR_APPS
    : (q.data?.apps ?? []);
  const needle = query.trim().toLowerCase();
  const apps = needle
    ? all.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          a.slug.toLowerCase().includes(needle) ||
          a.category.toLowerCase().includes(needle),
      )
    : all;

  return {
    apps,
    connectedCount: all.filter((a) => a.connected).length,
    connectable: q.data?.configured === true,
    isLoading: q.isLoading,
  };
}

/** Start a Composio OAuth connection; resolves to the redirect URL. */
export function useConnectApp(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...connectorappsConnectPostMutation(),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: connectorappsGetQueryKey({
          path: { assistant_id: assistantId },
          query: {},
        }),
      }),
  });
}

// ---------------------------------------------------------------------------
// "How Cue thinks" (onboarding-v2) — BYO OpenRouter key
// ---------------------------------------------------------------------------

/**
 * Cheap client-side validation of an OpenRouter API key before storing it:
 * `GET /api/v1/key` is OpenRouter's key-introspection endpoint (CORS `*`),
 * returning 200 for a live key and 401/403 for a bad one. Network failure is
 * reported distinctly so the UI can offer "store anyway" guidance.
 */
export async function validateOpenRouterKey(
  key: string,
): Promise<{ ok: boolean; reason: "invalid" | "network" | null }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true, reason: null };
    return { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/**
 * Store a validated OpenRouter key on the EXISTING BYO path: the daemon's
 * `POST /v1/secrets {type:"api_key", name:"openrouter"}` writes the secure
 * store at `credential/openrouter/api_key` — exactly the credential the
 * canonical `openrouter` provider connection (seeded every boot) resolves
 * via `resolveAuth`, i.e. the same override path the self-host
 * `OPENROUTER_API_KEY` / `CUE_OPENROUTER_MODEL` mechanism uses. No second
 * LLM-config path.
 */
export function useSaveOpenRouterKey() {
  return useMutation({ ...secretsPostMutation() });
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
