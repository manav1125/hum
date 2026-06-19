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
 * It does NOT change the auth model: the token is minted out-of-band via
 * `POST /v1/guardian/init` (bootstrap secret) — see the deploy README. This
 * screen only stores a token the user already holds; it grants nothing on its
 * own.
 */
export function CueConnectScreen() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

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
            Connect to Cue
          </h1>
          <p className="text-body-medium-default text-[var(--content-secondary)]">
            This is your self-hosted Cue. Paste the access token (or the connect
            link) you were given to sign in to this device.
          </p>
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
          variant="primary"
          size="regular"
          fullWidth
          disabled={!value.trim() || connecting}
          onClick={handleConnect}
        >
          {connecting ? "Connecting…" : "Connect"}
        </Button>

        <p className="text-body-small-default text-center text-[var(--content-secondary)]">
          Don't have a token? Mint one from your server with{" "}
          <code className="rounded bg-[var(--surface-raised)] px-1 py-0.5 font-mono text-[var(--content-default)]">
            POST /v1/guardian/init
          </code>{" "}
          (see the deploy README), then paste it here.
        </p>
      </div>
    </OnboardingLayout>
  );
}
