/**
 * Cue self-host sign-on entry point.
 *
 * Rendered (instead of the router) when this is the Cue self-host SPA and no
 * usable gateway token has been seeded yet — i.e. a fresh browser hitting the
 * hosted deploy, a lapsed session, or a fresh desktop install pointed at an
 * instance. It replaces the Vellum-Platform login / local-vs-cloud onboarding,
 * neither of which a single-tenant self-host can participate in.
 *
 * The screens themselves are the designed sign-on arc; see
 * `@/domains/onboarding/signon/signon-flow`. This file is only the boot-time
 * seam that chooses to show them, kept as a separate module because
 * `main.tsx` imports it eagerly and everything under `signon/` is
 * tree-shakeable behind it.
 *
 * The `?cueToken=` magic-link path does NOT come through here:
 * `bootstrapCueSelfHost()` seeds the token before `shouldShowCueConnectAsync()`
 * is consulted, so a valid link boots straight into the authenticated session
 * and never renders this screen at all.
 */
import { SignonFlow } from "@/domains/onboarding/signon/signon-flow";

export function CueConnectScreen() {
  return <SignonFlow />;
}
