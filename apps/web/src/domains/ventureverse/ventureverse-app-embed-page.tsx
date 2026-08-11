import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { ventureverseappsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * A VentureVerse app's launch screen inside Cue.
 *
 * NOT an inline runtime. VentureVerse's apps refuse to run embedded: each app
 * loads two iframes deep (Cue → VV shell → app) and gets its session from the
 * shell via a signed `sso_code` postMessage handshake that only completes when
 * VentureVerse is the top-level origin. Embedded under Cue the app rejects with
 * "SSO handshake timed out — this app must be opened from VentureVerse"
 * (verified 2026-08-11). That gate is VentureVerse-side; Cue can't join a
 * message channel between two VV frames or forge the signed code.
 *
 * So Cue is the LAUNCHER: this screen shows the app and opens it FIRST-PARTY,
 * where it works. `target="_blank"` opens a new tab on web; on desktop the
 * Electron shell routes it to the real external browser — first-party
 * ventureverse.com, where the user is already signed in and passkeys work.
 * A true inline embed would need VentureVerse to add an embed mode (allow
 * Cue's origin as an embedder + complete the SSO handshake for embedded
 * launches). See docs/ventureverse-embed.md.
 */
export function VentureverseAppEmbedPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.ventureverseApps();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const [opened, setOpened] = useState(false);

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
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            {app.iconUrl ? (
              <img
                src={app.iconUrl}
                alt=""
                className="size-16 rounded-[16px] object-cover"
              />
            ) : (
              <div
                aria-hidden
                className="flex size-16 items-center justify-center rounded-[16px] bg-[var(--surface-sunken)] text-title-medium text-[var(--content-secondary)]"
              >
                {app.name.slice(0, 1).toUpperCase()}
              </div>
            )}

            <div className="flex flex-col items-center gap-1.5">
              <h1 className="text-title-medium text-[var(--content-primary)]">
                {app.name}
              </h1>
              {app.category ? (
                <span className="text-body-small-lighter text-[var(--content-tertiary)]">
                  {app.category}
                </span>
              ) : null}
            </div>

            {app.description ? (
              <p className="text-body-medium-lighter text-[var(--content-secondary)]">
                {app.description}
              </p>
            ) : null}

            <a
              href={app.launchUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpened(true)}
              className="mt-1 inline-flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-5 py-2.5 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
            >
              Open {app.name}
              <ArrowUpRight className="size-4" aria-hidden />
            </a>

            <p className="text-body-small-lighter text-[var(--content-tertiary)]">
              {opened ? "Opened in a new window. " : ""}
              Opens on ventureverse.com in its own window, where you’re signed
              in. First time? Sign in there with email &amp; password or Google.
            </p>
          </div>
        </div>
      )}
    </PageShell>
  );
}
