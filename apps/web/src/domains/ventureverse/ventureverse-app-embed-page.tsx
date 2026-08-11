import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { ventureverseappsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { isElectron } from "@/runtime/is-electron";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * A VentureVerse app inside Cue.
 *
 * Two rendering paths, chosen at runtime:
 *
 * 1. **Desktop inline view** (Electron + `vvView` bridge + the
 *    `ventureverse-inline-embed` client flag): the app runs first-party in a
 *    native WebContentsView composited into this page's app area (see
 *    apps/macos/src/main/ventureverse-view.ts). VentureVerse is top-level
 *    there, so its SSO handshake completes and the app runs — visually
 *    embedded in Cue, no VentureVerse-side change. This is the real inline
 *    experience.
 *
 * 2. **Launch screen** (web, or any desktop build without the bridge/flag):
 *    a cross-origin iframe can't carry VentureVerse's SSO handshake, so we
 *    don't try — we show the app and open it first-party via `target=_blank`
 *    (a new tab on web; the external browser on desktop), where it works.
 */
export function VentureverseAppEmbedPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.ventureverseApps();
  const inlineEmbed =
    useClientFeatureFlagStore.use.ventureverseInlineEmbed();
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

  // The native view runs the app first-party inside Cue. Only when everything
  // that makes it work is present; otherwise fall back to the launch screen.
  const useNativeView =
    inlineEmbed && isElectron() && typeof window.vellum?.vvView !== "undefined";

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
        {app ? (
          <a
            href={app.launchUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-body-small-lighter text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-raised)] hover:text-[var(--content-primary)]"
          >
            <ArrowUpRight className="size-3.5" aria-hidden />
            Open in new tab
          </a>
        ) : null}
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
      ) : useNativeView ? (
        <NativeAppView launchUrl={app.launchUrl} />
      ) : (
        <LaunchScreen
          name={app.name}
          category={app.category}
          description={app.description}
          iconUrl={app.iconUrl}
          launchUrl={app.launchUrl}
        />
      )}
    </PageShell>
  );
}

/**
 * Anchors a native WebContentsView to the app area: opens it on mount, keeps
 * its bounds aligned as the layout resizes, tears it down on unmount. The div
 * itself is just the bounds anchor — the native view is painted over it by the
 * compositor, so a faint loading state sits behind it until it loads.
 */
function NativeAppView({ launchUrl }: { launchUrl: string }) {
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = anchorRef.current;
    const vv = window.vellum?.vvView;
    if (!el || !vv) return;

    const rectBounds = () => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };

    void vv.open(launchUrl, rectBounds());

    const sync = () => void vv.setBounds(rectBounds());
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    // Sidebar collapse / panel changes move the area without resizing it;
    // a scroll on any ancestor shifts it too. A light rAF settle covers the
    // transition frames.
    window.addEventListener("scroll", sync, true);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void vv.close();
    };
  }, [launchUrl]);

  return (
    <div ref={anchorRef} className="relative min-h-0 flex-1">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent" />
      </div>
    </div>
  );
}

/**
 * Web / no-bridge fallback: show the app and open it first-party, where its
 * SSO handshake works. A cross-origin iframe cannot carry that handshake, so
 * we deliberately don't embed one here.
 */
function LaunchScreen({
  name,
  category,
  description,
  iconUrl,
  launchUrl,
}: {
  name: string;
  category?: string;
  description?: string;
  iconUrl?: string;
  launchUrl: string;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        {iconUrl ? (
          <img
            src={iconUrl}
            alt=""
            className="size-16 rounded-[16px] object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="flex size-16 items-center justify-center rounded-[16px] bg-[var(--surface-sunken)] text-title-medium text-[var(--content-secondary)]"
          >
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}

        <div className="flex flex-col items-center gap-1.5">
          <h1 className="text-title-medium text-[var(--content-primary)]">
            {name}
          </h1>
          {category ? (
            <span className="text-body-small-lighter text-[var(--content-tertiary)]">
              {category}
            </span>
          ) : null}
        </div>

        {description ? (
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            {description}
          </p>
        ) : null}

        <a
          href={launchUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => setOpened(true)}
          className="mt-1 inline-flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-5 py-2.5 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
        >
          Open {name}
          <ArrowUpRight className="size-4" aria-hidden />
        </a>

        <p className="text-body-small-lighter text-[var(--content-tertiary)]">
          {opened ? "Opened in a new window. " : ""}
          Opens on ventureverse.com in its own window, where you’re signed in.
          First time? Sign in there with email &amp; password or Google.
        </p>
      </div>
    </div>
  );
}
