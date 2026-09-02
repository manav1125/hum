import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router";

import { PageShell } from "@/components/page-shell";
import { buildVellumHeaders } from "@/lib/auth/request-headers";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * Learn — the embedded OpenMAIC interactive classroom.
 *
 * OpenMAIC runs as a sidecar service mounted on the Cue origin by the
 * gateway's `/learn/*` proxy (see gateway/src/http/routes/learn-proxy.ts),
 * so this page is a plain same-origin iframe — no native webview and no
 * partner SSO handshake, unlike the VentureVerse embed. The only credential
 * dance is the learn-session cookie: an iframe cannot attach the SPA's
 * Bearer header, so before mounting the frame we POST `/learn/cue-session`
 * (which CAN carry the header) and the gateway answers with an HttpOnly
 * cookie that every subsequent framed request rides on.
 *
 * The cookie is minted fresh on every page mount — its signing secret is
 * per-gateway-process, so re-minting here is what makes gateway restarts
 * invisible.
 *
 * Flag contract: gated by `learn-app` with the standard hydration pair, and
 * the page self-redirects when the flag is off, so a deep link is safe in
 * both directions (same contract as the VentureVerse pages).
 */

type SessionState = "minting" | "ready" | "unconfigured" | "error";

export function LearnPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.learnApp();
  const [session, setSession] = useState<SessionState>("minting");

  const mintSession = useCallback(async () => {
    setSession("minting");
    try {
      // The gateway route authenticates the Bearer edge token itself; CSRF
      // headers are a daemon/platform concern, so the safe-request builder
      // is the right one here despite the POST.
      const res = await fetch("/learn/cue-session", {
        method: "POST",
        headers: buildVellumHeaders(),
        credentials: "include",
      });
      if (res.status === 404) {
        setSession("unconfigured");
        return;
      }
      setSession(res.ok ? "ready" : "error");
    } catch {
      setSession("error");
    }
  }, []);

  useEffect(() => {
    if (hasHydrated && enabled) void mintSession();
  }, [hasHydrated, enabled, mintSession]);

  if (!hasHydrated) return null;
  if (!enabled) return <Navigate to={routes.hq} replace />;

  return (
    <PageShell className="max-md:px-0 max-md:py-0 md:px-0 md:py-0">
      {session === "ready" ? (
        <iframe
          // No trailing slash: Next normalizes `/learn/` → `/learn` with a
          // 308, so the bare path skips a redirect hop.
          src="/learn"
          title="Learn"
          className="min-h-0 w-full flex-1 border-0"
          // Full app surface: OpenMAIC uses mic input (talk to the teacher),
          // audio playback, and downloads (PPTX/HTML export).
          allow="microphone; autoplay; clipboard-write; fullscreen"
        />
      ) : session === "minting" ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent" />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            {session === "unconfigured"
              ? "Learn isn’t set up on this Cue yet — the OpenMAIC service isn’t configured."
              : "Couldn’t open Learn."}
          </p>
          {session === "error" ? (
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
