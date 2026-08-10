import { ArrowLeft, ExternalLink } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { ventureverseappsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * A VentureVerse app, running embedded in Cue.
 *
 * The iframe loads the VentureVerse SHELL with the app launched
 * (`www.ventureverse.com/apps?launch=<slug>` — the `launchUrl` the daemon
 * catalog prebuilds), not the app's own deployment: the shell owns auth,
 * credits, and the short-lived `iframe_token` handoff to the app's nested
 * frame, so Cue gets the whole working product by embedding one origin.
 *
 * AUTH: VentureVerse sessions are its own localStorage under the embedded
 * frame's (partitioned) origin — the user signs in inside the frame once and
 * stays signed in for Cue's embed. No Cue credentials cross the boundary.
 * Google OAuth can't run inside an iframe, so VentureVerse's sign-in must
 * pop up for that path (email/password works in-frame); popups are why the
 * frame is NOT sandboxed — it's the parent org's own product, and a sandbox
 * either blocks the popup flow or (with every allowance) adds nothing.
 *
 * Desktop note: the Electron shell's CSP must carry
 * `frame-src https://*.ventureverse.com` (apps/macos/src/main/csp.ts) or
 * this page renders an empty rectangle there while working in the browser.
 */
export function VentureverseAppEmbedPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.ventureverseApps();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();

  const appsQuery = useQuery({
    ...ventureverseappsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: assistantId !== null && hasHydrated && enabled,
    staleTime: 60_000,
  });

  if (!hasHydrated) return null;
  if (!enabled) return <Navigate to={routes.hq} replace />;

  const app = appsQuery.data?.apps.find((a) => a.slug === slug);

  return (
    <PageShell className="max-md:px-0 max-md:py-0 md:px-0 md:py-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-2.5">
        <button
          type="button"
          onClick={() => void navigate(routes.ventureverseApps.root)}
          aria-label="Back to Apps"
          className="flex size-8 items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-raised)] hover:text-[var(--content-primary)]"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body-medium-default text-[var(--content-primary)]">
            {app?.name ?? "VentureVerse app"}
          </div>
        </div>
        {app && (
          <a
            href={app.launchUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-body-small-lighter text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-raised)] hover:text-[var(--content-primary)]"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            Open on VentureVerse
          </a>
        )}
      </div>

      {appsQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent" />
        </div>
      ) : !app ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            {appsQuery.isError
              ? "Couldn’t load the app catalog."
              : "That app isn’t in the catalog."}
          </p>
          <button
            type="button"
            onClick={() => void navigate(routes.ventureverseApps.root)}
            className="text-body-small-default text-[var(--content-primary)] underline underline-offset-2"
          >
            Back to Apps
          </button>
        </div>
      ) : (
        <iframe
          key={app.slug}
          src={app.launchUrl}
          title={app.name}
          allow="clipboard-read; clipboard-write; fullscreen"
          className="min-h-0 w-full flex-1 border-0"
        />
      )}
    </PageShell>
  );
}
