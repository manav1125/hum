import { ArrowLeft, ExternalLink, Info, X } from "lucide-react";
import { useState } from "react";
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
 * AUTH — the load-bearing constraint. Browsers PARTITION a cross-origin
 * iframe's storage by the embedding top site, so VentureVerse inside this
 * frame gets an isolated bucket that can't see the user's first-party VV
 * session. Two consequences the UI has to own:
 *   1. Signing in with EMAIL/PASSWORD works in-frame — the session lands in
 *      the frame's own partition and persists there.
 *   2. Signing in with GOOGLE / a passkey does NOT: it runs in a popup whose
 *      session lands in VV's first-party bucket (and on desktop the passkey
 *      ceremony can't complete in a popup opened from an embedded frame), so
 *      the frame still reads "logged out" and loops back to the login screen.
 * The fix that needs no VentureVerse change is to send Google/passkey users
 * to a first-party top-level window — `target="_blank"` here, which the
 * Electron shell routes to the real external browser (where the user is
 * already signed in first-party). The {@link SignInHint} banner tells them so.
 * A fully-embedded Google SSO would need VentureVerse to add the Storage
 * Access API or a postMessage SSO handshake on their side.
 *
 * The frame is deliberately NOT sandboxed — it's the parent org's own product,
 * and the popup/window-open paths above need to work.
 *
 * Desktop note: the Electron shell's CSP must carry
 * `frame-src https://*.ventureverse.com` (apps/macos/src/main/csp.ts) or
 * this page renders an empty rectangle there while working in the browser.
 */

const SIGNIN_HINT_STORE_ID = "vv-signin-hint-dismissed";

function readHintDismissed(): boolean {
  try {
    return localStorage.getItem(SIGNIN_HINT_STORE_ID) === "1";
  } catch {
    return false;
  }
}

/**
 * The one thing a user hits that the embed can't do: sign in with Google.
 * A slim, dismissible bar that names the working path (email/password here)
 * and offers the reliable escape (open in a full window). Dismissal persists.
 */
function SignInHint({ launchUrl }: { launchUrl: string }) {
  const [dismissed, setDismissed] = useState(readHintDismissed);
  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(SIGNIN_HINT_STORE_ID, "1");
    } catch {
      // Non-fatal — the hint just reappears next time.
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] bg-[var(--surface-raised)] px-4 py-2">
      <Info
        className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
        aria-hidden
      />
      <p className="min-w-0 flex-1 text-body-small-lighter text-[var(--content-secondary)]">
        First time here? Sign in with <strong>email &amp; password</strong>{" "}
        right here. Signing in with <strong>Google</strong> or a passkey needs a
        full window —{" "}
        <a
          href={launchUrl}
          target="_blank"
          rel="noreferrer"
          className="whitespace-nowrap font-medium text-[var(--content-primary)] underline underline-offset-2"
        >
          open in a new tab
        </a>
        .
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-base)] hover:text-[var(--content-primary)]"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

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
            Open in new tab
          </a>
        )}
      </div>

      {app ? <SignInHint launchUrl={app.launchUrl} /> : null}

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
