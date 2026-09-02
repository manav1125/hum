import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router";

import { PageShell } from "@/components/page-shell";
import { buildVellumHeaders } from "@/lib/auth/request-headers";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * Design — the embedded Cue Design studio (OpenDesign fork).
 *
 * Cue Design runs as a sidecar service on its OWN hostname (its frontend
 * hardcodes absolute `/api/...` paths and has no basePath support, so unlike
 * Learn it cannot mount under a path on the app origin). The gateway
 * host-dispatches that hostname to the sidecar (see
 * gateway/src/http/routes/design-proxy.ts), and this page embeds it in an
 * iframe. The frame is cross-origin but SAME-SITE — both hosts share the
 * registrable domain — which is exactly what makes the cookie dance work: an
 * iframe cannot attach the SPA's Bearer header, so before mounting the frame
 * we POST `/design/cue-session` (which CAN carry the header) and the gateway
 * answers with an HttpOnly cookie scoped to the PARENT domain plus the design
 * surface URL for the frame's src. SameSite=Lax sends that parent-domain
 * cookie on every same-site framed request.
 *
 * The cookie is minted fresh on every page mount — its signing secret is
 * per-gateway-process, so re-minting here is what makes gateway restarts
 * invisible.
 *
 * Flag contract: gated by `design-app` with the standard hydration pair, and
 * the page self-redirects when the flag is off, so a deep link is safe in
 * both directions (same contract as the Learn and VentureVerse pages).
 */

type SessionState =
  | { phase: "minting" }
  | { phase: "ready"; url: string }
  | { phase: "unconfigured" }
  | { phase: "error" };

export function DesignPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.designApp();
  const [session, setSession] = useState<SessionState>({ phase: "minting" });

  const mintSession = useCallback(async () => {
    setSession({ phase: "minting" });
    try {
      // The gateway route authenticates the Bearer edge token itself; CSRF
      // headers are a daemon/platform concern, so the safe-request builder
      // is the right one here despite the POST (same call as Learn).
      const res = await fetch("/design/cue-session", {
        method: "POST",
        headers: buildVellumHeaders(),
        credentials: "include",
      });
      if (res.status === 404) {
        setSession({ phase: "unconfigured" });
        return;
      }
      if (!res.ok) {
        setSession({ phase: "error" });
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (typeof body.url === "string" && body.url.length > 0) {
        setSession({ phase: "ready", url: body.url });
      } else {
        setSession({ phase: "error" });
      }
    } catch {
      setSession({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    if (hasHydrated && enabled) void mintSession();
  }, [hasHydrated, enabled, mintSession]);

  if (!hasHydrated) return null;
  if (!enabled) return <Navigate to={routes.hq} replace />;

  return (
    <PageShell className="max-md:px-0 max-md:py-0 md:px-0 md:py-0">
      {session.phase === "ready" ? (
        <iframe
          src={session.url}
          title="Design"
          className="min-h-0 w-full flex-1 border-0"
          // Full studio surface: Cue Design plays media previews, writes to
          // the clipboard (copy-for-CLI, copy path), and exports downloads
          // (HTML/PDF/PPTX/MP4).
          allow="autoplay; clipboard-write; fullscreen"
        />
      ) : session.phase === "minting" ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent" />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            {session.phase === "unconfigured"
              ? "Design isn’t set up on this Cue yet — the Cue Design service isn’t configured."
              : "Couldn’t open Design."}
          </p>
          {session.phase === "error" ? (
            <button
              type="button"
              onClick={() => void mintSession()}
              className="text-body-small-default text-[var(--content-primary)] underline underline-offset-2"
            >
              Try again
            </button>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
