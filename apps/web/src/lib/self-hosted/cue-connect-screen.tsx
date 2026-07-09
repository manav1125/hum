import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { seedCueToken } from "@/lib/self-hosted/cue-self-host";

/**
 * Cue self-host Connect screen.
 *
 * Rendered (instead of the router) when this is the Cue self-host SPA and no
 * gateway token has been seeded yet — i.e. a fresh browser hitting the hosted
 * deploy. Replaces the confusing Vellum-Platform login / local-vs-cloud
 * onboarding (which don't apply to a single-tenant self-host) with a single,
 * Cue-branded step: paste the access token (or the connect link) you were
 * handed, and the SPA boots into its authenticated `self` session.
 *
 * Primary path is email sign-in: the button hands off to the hosted Cue
 * sign-in page (Cue HQ), which emails a one-time magic link that lands back
 * here as `?cueToken=` and boots the authenticated `self` session. The raw
 * access-token paste is kept as an "advanced" fallback for anyone who already
 * holds a token (minted via `POST /v1/guardian/init` — see the deploy README).
 * Neither path changes the auth model; this screen just gets a token onto the
 * device.
 */

// Hosted Cue sign-in (email → magic link). Overridable per-deploy at build
// time; defaults to the Cue cloud so a standard self-host "just works".
const SIGNIN_URL =
  (import.meta.env.VITE_CUE_SIGNIN_URL as string | undefined) ??
  "https://justcue.ai/signin";

export function CueConnectScreen() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showToken, setShowToken] = useState(false);

  function handleConnect() {
    setError(null);
    const ok = seedCueToken(value);
    if (!ok) {
      setError(
        "That doesn't look like a valid access token. Paste the token (or the full connect link) you were given.",
      );
      return;
    }
    setConnecting(true);
    // Reload at the app root so the normal authenticated boot path runs and
    // picks up the freshly-seeded gateway token.
    window.location.assign("/assistant/");
  }

  return (
    <OnboardingLayout>
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
        <div className="flex flex-col gap-2 text-center">
          <h1 className="text-display-small-default text-[var(--content-default)]">
            Sign in to Cue
          </h1>
          <p className="text-body-medium-default text-[var(--content-secondary)]">
            This is your Cue. Sign in with your email and we&apos;ll send you a
            secure link to this device — no password.
          </p>
        </div>

        <Button
          variant="primary"
          size="regular"
          fullWidth
          onClick={() => window.location.assign(SIGNIN_URL)}
        >
          Sign in with email
        </Button>

        {!showToken ? (
          <button
            type="button"
            onClick={() => setShowToken(true)}
            className="text-body-small-default text-center text-[var(--content-secondary)] underline underline-offset-2 hover:text-[var(--content-default)]"
          >
            Have an access token? Paste it instead
          </button>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-[var(--border-element)]" />
              <span className="text-label-small-default text-[var(--content-secondary)]">
                or use an access token
              </span>
              <div className="h-px flex-1 bg-[var(--border-element)]" />
            </div>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="cue-token"
                className="text-label-medium-default text-[var(--content-secondary)]"
              >
                Access token
              </label>
              <textarea
                id="cue-token"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter to submit from the textarea.
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    handleConnect();
                  }
                }}
                rows={4}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="eyJhbGciOi…  or  https://your-cue…/assistant/?cueToken=…"
                className="w-full resize-none rounded-md border border-[var(--border-element)] bg-[var(--surface-raised)] px-3 py-2 font-mono text-body-small-default text-[var(--content-default)] outline-none placeholder:text-[var(--content-disabled)] focus:border-[var(--primary-base)]"
              />
              {error && (
                <p className="text-body-small-default text-[var(--system-negative-strong)]">
                  {error}
                </p>
              )}
            </div>
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              disabled={!value.trim() || connecting}
              onClick={handleConnect}
            >
              {connecting ? "Connecting…" : "Connect with token"}
            </Button>
          </div>
        )}
      </div>
    </OnboardingLayout>
  );
}
