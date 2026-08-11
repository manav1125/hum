import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { ventureverseappsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { VentureverseappsGetResponses } from "@/generated/daemon/types.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * Apps — the VentureVerse app store embedded in Cue (Tier-2 "Apps" sidebar
 * row, `ventureverse-apps` assistant feature flag).
 *
 * DATA SOURCE: `GET /v1/ventureverse-apps` — the daemon-cached catalog off
 * ventureverse.com's public API (curated static fallback when unreachable),
 * one route for every client so counts can't disagree (the connector-apps
 * rule). Cards navigate to `/assistant/apps/:slug`, where the app runs in an
 * embedded VentureVerse frame — see `ventureverse-app-embed-page.tsx` for the
 * auth story.
 *
 * Flag OFF → redirect to HQ (the marketplace pattern: wait for the first real
 * `/feature-flags` response before deciding, so a deep link with the flag on
 * is never bounced during the defaults window).
 */

type VentureverseApp =
  VentureverseappsGetResponses[200]["apps"][number];

/** Monogram chip fallback when an app icon is missing or fails to load. */
function AppMonogram({ name }: { name: string }) {
  return (
    <div
      aria-hidden
      className="flex size-12 shrink-0 items-center justify-center rounded-[12px] bg-[var(--surface-sunken)] text-body-large-default text-[var(--content-secondary)]"
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function AppIcon({ app }: { app: VentureverseApp }) {
  const [failed, setFailed] = useState(false);
  if (!app.iconUrl || failed) return <AppMonogram name={app.name} />;
  return (
    <img
      src={app.iconUrl}
      alt=""
      className="size-12 shrink-0 rounded-[12px] object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function AppCard({
  app,
  onOpen,
}: {
  app: VentureverseApp;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-4 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)]"
    >
      <div className="flex items-center gap-3">
        <AppIcon app={app} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body-medium-default text-[var(--content-primary)]">
            {app.name}
          </div>
          <div className="truncate text-body-small-lighter text-[var(--content-tertiary)]">
            {app.category}
          </div>
        </div>
      </div>
      <p className="line-clamp-3 text-body-small-lighter text-[var(--content-secondary)]">
        {app.description}
      </p>
    </button>
  );
}

export function VentureverseAppsPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.ventureverseApps();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const appsQuery = useQuery({
    ...ventureverseappsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: assistantId !== null && hasHydrated && enabled,
    staleTime: 60_000,
  });

  const apps = useMemo(() => {
    const all = appsQuery.data?.apps ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // Filter client-side so typing doesn't refetch per keystroke.
    return all.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }, [appsQuery.data, query]);

  // Wait for the first real /feature-flags response before deciding to
  // redirect — never bounce a user who has the flag on during the defaults
  // window (the marketplace rule).
  if (!hasHydrated) return null;
  if (!enabled) return <Navigate to={routes.hq} replace />;

  return (
    <PageShell>
      <div className="mb-1 flex shrink-0 items-baseline justify-between gap-3">
        <h1 className="text-title-medium text-[var(--content-primary)]">
          Apps
        </h1>
        <span className="text-body-small-lighter text-[var(--content-tertiary)]">
          Powered by VentureVerse
        </span>
      </div>
      <p className="mb-4 shrink-0 text-body-small-lighter text-[var(--content-secondary)]">
        Founder tools that run right here — legal analysis, deck review,
        market sizing, pricing, and more. First time in an app, sign in with
        your VentureVerse email &amp; password (Google sign-in opens in a new
        tab).
      </p>

      <div className="mb-5 flex shrink-0 items-center gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2">
        <Search
          className="size-4 shrink-0 text-[var(--content-tertiary)]"
          aria-hidden
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search apps by name, category, or what they do…"
          className="w-full bg-transparent text-body-medium-lighter text-[var(--content-primary)] outline-none placeholder:text-[var(--content-tertiary)]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {appsQuery.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent" />
          </div>
        ) : appsQuery.isError ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
            <p className="text-body-medium-lighter text-[var(--content-secondary)]">
              Couldn&rsquo;t load the app catalog.
            </p>
            <p className="text-body-small-lighter text-[var(--content-tertiary)]">
              Check your connection and try again.
            </p>
          </div>
        ) : apps.length === 0 ? (
          <p className="py-10 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
            No apps match &ldquo;{query}&rdquo;.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 pb-4 sm:grid-cols-2 xl:grid-cols-3">
            {apps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                onOpen={() =>
                  void navigate(routes.ventureverseApps.app(app.slug))
                }
              />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
