import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import { CueConnectScreen } from "@/lib/self-hosted/cue-connect-screen";
import { isCueSelfHostInstall } from "@/lib/self-hosted/cue-self-host";
import { startAuthFlow } from "@/runtime/native-auth";

/**
 * Signup redirect page. Immediately triggers the auth flow with
 * `intent: "signup"` so WorkOS opens the sign-up screen.
 *
 * `startAuthFlow` routes through the native `ASWebAuthenticationSession`
 * path on Capacitor iOS (the signup link on `/account/login` is
 * reachable inside the shell, so this page must not hit the embedded
 * WKWebView OAuth flow that Google blocks).
 *
 * On a Cue self-hosted install this page renders the Cue sign-on flow
 * instead and fires nothing. Note that the redirect below runs from an
 * EFFECT, with no click: merely landing on this route was enough to send
 * the owner of a single-tenant instance to a third party's identity
 * provider. There is no account there to sign up for, so the effect must
 * not run at all — guarding the render alone would be too late.
 */
export function SignupPage() {
  const didRedirect = useRef(false);
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const cueSelfHost = isCueSelfHostInstall();

  useEffect(() => {
    if (cueSelfHost) return;
    if (didRedirect.current) return;
    didRedirect.current = true;

    const returnTo = searchParams.get("returnTo");
    const callbackUrl = buildProviderCallbackUrl(returnTo, {
      authIntent: "signup",
    });

    startAuthFlow(PROVIDER_ID, callbackUrl, {
      intent: "signup",
      returnTo,
    }).catch((err) => {
      console.error("[signup] auth flow failed:", err);
      setError("Something went wrong. Please try again.");
    });
  }, [searchParams, cueSelfHost]);

  if (cueSelfHost) return <CueConnectScreen />;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[var(--system-negative-strong)]">{error}</p>
      </div>
    );
  }

  return null;
}
