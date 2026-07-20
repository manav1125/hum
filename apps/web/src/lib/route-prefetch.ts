/**
 * Route-loader query prefetch — kills the chunk→data serial chain on the
 * lazy main surfaces.
 *
 * Lazy routes previously fired their first query only after the route chunk
 * downloaded and the page mounted (+341 ms projects … +856 ms skills, per
 * docs/perf-2026-07-20/web-datapath.md §1). React Router resolves a route's
 * static `loader` in parallel with its `lazy` component, so each main
 * surface's loader calls `prefetchRoute(<surface>)` here to start the
 * surface's primary query while the chunk is still in flight.
 *
 * Everything is strictly best-effort and non-blocking:
 * - Loaders never await the prefetch — they return immediately so
 *   navigation is never slower than before.
 * - The QueryClient lives inside the React tree (auth/org-scoped, see
 *   `providers.tsx`), so it is registered here via
 *   `setRoutePrefetchQueryClient` after mount. A cold-boot loader that runs
 *   before providers mount waits (bounded) for registration.
 * - When auth/org/assistant context isn't ready the prefetch is silently
 *   skipped — the page's own `useQuery` (with its `enabled` gating) remains
 *   the source of truth. Prefetching an already-fresh cache is a no-op.
 *
 * The prefetched options MUST match the consuming page's queryKey exactly —
 * each entry below names the consumer it mirrors.
 */
import type { QueryClient } from "@tanstack/react-query";

import {
  connectorappsGetOptions,
  homeFeedGetOptions,
  projectsGetOptions,
  skillsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { fetchNextMove, nextMoveQueryKey } from "@/pages/command-center/use-next-move";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  hasLivePlatformSession,
  isAuthenticated,
} from "@/stores/session-status";
import { conversationListOptions } from "@/utils/conversation-list-fetchers";

// ---------------------------------------------------------------------------
// QueryClient registry
// ---------------------------------------------------------------------------

let activeQueryClient: QueryClient | null = null;
let registrationWaiters: Array<(qc: QueryClient) => void> = [];

/**
 * Register (or clear) the request-scoped QueryClient for loader prefetches.
 * Called from `providers.tsx` whenever the innermost QueryClient mounts or
 * is swapped (login/logout/org switch).
 */
export function setRoutePrefetchQueryClient(qc: QueryClient | null): void {
  activeQueryClient = qc;
  if (qc) {
    const waiters = registrationWaiters;
    registrationWaiters = [];
    for (const resolve of waiters) resolve(qc);
  }
}

/** How long a cold-boot loader waits for providers to mount. */
const QUERY_CLIENT_WAIT_MS = 3_000;

function waitForQueryClient(): Promise<QueryClient | null> {
  if (activeQueryClient) return Promise.resolve(activeQueryClient);
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(activeQueryClient),
      QUERY_CLIENT_WAIT_MS,
    );
    registrationWaiters.push((qc) => {
      clearTimeout(timer);
      resolve(qc);
    });
  });
}

// ---------------------------------------------------------------------------
// Context snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot equivalent of the hook-level gates the pages apply
 * (`useIsOrgReady`, `useActiveAssistantId`): only prefetch when requests
 * would carry the right auth/org context and target a resolved assistant.
 */
function snapshotAssistantId(): string | null {
  const { sessionStatus, platformSession } = useAuthStore.getState();
  if (!isAuthenticated(sessionStatus)) return null;
  const hasPlatform = hasLivePlatformSession(platformSession);
  const orgReady =
    !hasPlatform ||
    useOrganizationStore.getState().currentOrganizationId != null;
  if (!orgReady) return null;
  return useResolvedAssistantsStore.getState().activeAssistantId;
}

// ---------------------------------------------------------------------------
// Per-surface prefetches
// ---------------------------------------------------------------------------

export type PrefetchableSurface =
  | "hq"
  | "projects"
  | "chats"
  | "channels"
  | "skills";

function prefetchSurfaceQueries(
  qc: QueryClient,
  assistantId: string,
  surface: PrefetchableSurface,
): void {
  const path = { assistant_id: assistantId };

  // Every main surface renders inside ChatLayout, whose sidebar reads the
  // foreground conversation list — warm it everywhere (single round-trip;
  // no-op when the cache is fresh).
  void qc.prefetchQuery(conversationListOptions(assistantId));

  switch (surface) {
    case "hq":
      // Mirrors `useNextMove` (pages/command-center/use-next-move.ts) and
      // `useHomeFeedQuery` (domains/home/hooks/use-home-feed-query.ts).
      void qc.prefetchQuery({
        queryKey: nextMoveQueryKey(assistantId),
        queryFn: () => fetchNextMove(assistantId),
        staleTime: 10_000,
        retry: false,
      });
      void qc.prefetchQuery({
        ...homeFeedGetOptions({ path, query: { timeAwaySeconds: 0 } }),
        staleTime: 5 * 60_000,
      });
      break;
    case "projects":
      // Mirrors `useProjects` (pages/projects/use-projects.ts).
      void qc.prefetchQuery({
        ...projectsGetOptions({ path }),
        staleTime: 20_000,
      });
      break;
    case "chats":
      // The shared conversation-list prefetch above IS the primary query.
      break;
    case "channels":
      // Mirrors the connections read (mobile-v3/you/connections-page.tsx and
      // the desktop Tools & Apps page) — same options → same queryKey.
      void qc.prefetchQuery({
        ...connectorappsGetOptions({ path, query: {} }),
        staleTime: 60_000,
      });
      break;
    case "skills":
      // Mirrors the default (filter "all", no search/category) skills query
      // in components/skills/skills-tab.tsx. Undefined query params hash
      // identically to absent ones, so this matches the page's initial key.
      void qc.prefetchQuery({
        ...skillsGetOptions({ path, query: { include: "catalog" } }),
      });
      break;
  }
}

/**
 * Entry point for route loaders. Fire-and-forget: resolves context, then
 * kicks the surface's primary queries into the shared cache.
 */
export function prefetchRoute(surface: PrefetchableSurface): void {
  void (async () => {
    try {
      const qc = await waitForQueryClient();
      if (!qc) return;
      const assistantId = snapshotAssistantId();
      if (!assistantId) return;
      prefetchSurfaceQueries(qc, assistantId, surface);
    } catch {
      // Best-effort only — the page's own queries fetch on mount regardless.
    }
  })();
}
