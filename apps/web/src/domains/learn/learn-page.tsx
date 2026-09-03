import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { PageShell } from "@/components/page-shell";
import { mintLearnSession } from "@/lib/learn-session";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * Learn — the embedded Cue Learn classroom (OpenMAIC fork).
 *
 * The sidecar is mounted on the Cue origin by the gateway's `/learn/*` proxy
 * (see gateway/src/http/routes/learn-proxy.ts), so this page is a plain
 * same-origin iframe. The only credential dance is the learn-session cookie:
 * an iframe cannot attach the SPA's Bearer header, so before mounting the
 * frame we POST `/learn/cue-session` (which CAN carry the header) and the
 * gateway answers with an HttpOnly cookie that every framed request rides on.
 * The cookie is minted fresh on every mount — its signing secret is
 * per-gateway-process, so re-minting here is what makes restarts invisible.
 *
 * Deep links + URL sync: `?p=<path under /learn>` opens the frame there
 * (`/assistant/learn?p=/classroom/abc` — what the `learn` skill links to),
 * and while the user navigates inside the classroom the same param is kept
 * up to date by polling the same-origin frame's location, so refresh and
 * share land back in the right room instead of the Learn home.
 *
 * Ask-Cue bridge: the classroom posts `{ type: "cue-learn:ask", prompt }`
 * (same-origin postMessage); we forward it to Talk to Cue via the composer's
 * existing `?prompt=` auto-send (the quick-input path).
 *
 * Flag contract: gated by `learn-app` with the standard hydration pair, and
 * the page self-redirects when the flag is off, so a deep link is safe in
 * both directions (same contract as the VentureVerse pages).
 */

type SessionState = "minting" | "ready" | "unconfigured" | "error";

/** Paths we'll open/reflect inside the frame: absolute, no scheme smuggling. */
function sanitizeLearnPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("..")) return null;
  return raw;
}

export function LearnPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.learnApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [session, setSession] = useState<SessionState>("minting");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The frame's src is set once from the mount-time deep link; afterwards the
  // user navigates inside the frame and the URL param follows the frame, not
  // the other way around (re-setting src would reload the classroom). A
  // one-shot useState initializer, so later ?p= updates never touch src.
  const [initialPath] = useState<string | null>(() =>
    sanitizeLearnPath(searchParams.get("p")),
  );

  const mintSession = useCallback(async () => {
    setSession("minting");
    setSession(await mintLearnSession());
  }, []);

  useEffect(() => {
    if (hasHydrated && enabled) void mintSession();
  }, [hasHydrated, enabled, mintSession]);

  // Reflect in-frame navigation into ?p= so refresh/share return to the same
  // room. Poll rather than listen: client-side router hops inside the frame
  // fire no load events, and the frame is same-origin so reading its
  // location is cheap. Wrapped in try/catch for the moments the frame hosts
  // an error page from a different origin-less state.
  useEffect(() => {
    if (session !== "ready") return;
    const interval = setInterval(() => {
      const frame = iframeRef.current;
      if (!frame?.contentWindow) return;
      try {
        const { pathname, search } = frame.contentWindow.location;
        if (!pathname.startsWith("/learn")) return;
        const inner = `${pathname.slice("/learn".length) || "/"}${search}`;
        const current = sanitizeLearnPath(searchParams.get("p")) ?? "/";
        if (inner !== current) {
          setSearchParams(
            inner === "/" ? {} : { p: inner },
            { replace: true },
          );
        }
      } catch {
        // Cross-origin or detached frame — skip this tick.
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [session, searchParams, setSearchParams]);

  // Ask-Cue bridge: same-origin messages from the classroom → Talk to Cue
  // with the composer's ?prompt= auto-send.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; prompt?: string } | null;
      if (data?.type !== "cue-learn:ask") return;
      const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
      if (!prompt || prompt.length > 4000) return;
      void navigate(
        `${routes.assistant}?prompt=${encodeURIComponent(prompt)}`,
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate]);

  if (!hasHydrated) return null;
  if (!enabled) return <Navigate to={routes.hq} replace />;

  return (
    <PageShell className="max-md:px-0 max-md:py-0 md:px-0 md:py-0">
      <style>{`
        @keyframes cueLearnDoorway {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .cue-learn-doorway {
          animation: cueLearnDoorway 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
        }
        @media (prefers-reduced-motion: reduce) {
          .cue-learn-doorway {
            animation: cueLearnDoorway 80ms linear;
            transform: none;
          }
        }
      `}</style>
      {session === "ready" ? (
        <iframe
          ref={iframeRef}
          // No trailing slash on the bare surface: Next normalizes
          // `/learn/` → `/learn` with a 308, so skip the redirect hop.
          src={initialPath ? `/learn${initialPath}` : "/learn"}
          title="Learn"
          // The doorway (design R2-1): entering Learn rises 12px and fades in
          // over 240ms; under prefers-reduced-motion the keyframes collapse to
          // a quick crossfade via the media query in the style tag below.
          className="cue-learn-doorway min-h-0 w-full flex-1 border-0"
          // Full app surface: Cue Learn uses mic input (talk to the teacher),
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
              ? "Learn isn’t set up on this Cue yet — the Cue Learn service isn’t configured."
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
